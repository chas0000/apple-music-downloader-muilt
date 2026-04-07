package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/spf13/pflag"
	"main/internal/api"
	"main/internal/core"
	"main/internal/downloader"
	"main/internal/parser"
)

var jsonOutput bool

func printJSONError(message string) {
	type JsonError struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	errJSON, _ := json.Marshal(JsonError{
		Status:  "error",
		Message: message,
	})
	fmt.Println(string(errJSON))
}

type LogEntry struct {
	Content string `json:"content"`
	Time    string `json:"time"`
}

type jsonStatus struct {
	Status    string `json:"status"`
	TrackNum  int    `json:"trackNum"`
	TrackName string `json:"trackName"`
	AlbumName string `json:"albumName"`
	AlbumID   string `json:"albumId"`
	Percentage int   `json:"percentage"`
	Speed     string `json:"speed"`
	Message   string `json:"message"`
	TaskLine  int    `json:"taskLine"`
}

var (
	logHistory      []LogEntry
	logMutex        sync.Mutex
	serverMode      bool
	port            int
	progressActive  bool
	progressLabel   string
	taskLineMap     map[string]int = make(map[string]int)
	taskLineMutex   sync.Mutex
	nextTaskLine    int = 0
)

func getTaskLineID(status *jsonStatus) string {
	return fmt.Sprintf("%s-%d", status.AlbumID, status.TrackNum)
}

func allocateTaskLine(status *jsonStatus) int {
	taskLineID := getTaskLineID(status)
	taskLineMutex.Lock()
	defer taskLineMutex.Unlock()

	if line, exists := taskLineMap[taskLineID]; exists {
		return line
	}

	line := nextTaskLine
	taskLineMap[taskLineID] = line
	nextTaskLine++
	return line
}

func renderProgressLine(status *jsonStatus) {
	label := status.TrackName
	if label == "" {
		label = status.AlbumName
	}
	if label == "" {
		label = "下载任务"
	}

	statusText := strings.ToLower(status.Status)
	percent := status.Percentage
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}

	barWidth := 30
	filled := int(float64(barWidth) * float64(percent) / 100.0)
	empty := barWidth - filled
	bar := strings.Repeat("=", filled) + strings.Repeat("-", empty)
	message := ""
	if status.Speed != "" {
		message += status.Speed
	}
	if status.Message != "" {
		if message != "" {
			message += " "
		}
		message += status.Message
	}
	if message == "" {
		message = "processing"
	}

	// 为任务分配行号
	taskLine := allocateTaskLine(status)

	if statusText == "complete" || statusText == "error" {
		fmt.Printf("[%s] %3d%%  %s %s\n", bar, percent, label, message)
		taskLineMutex.Lock()
		delete(taskLineMap, getTaskLineID(status))
		taskLineMutex.Unlock()
		progressActive = false
		return
	}

	// 在服务器模式下禁用ANSI控制码，直接输出到新行
	if serverMode {
		fmt.Printf("[%s] %3d%%  %s %s\n", bar, percent, label, message)
		progressActive = true
		return
	}

	// CLI模式下，多线程时使用ANSI光标控制将进度显示在不同行
	if taskLine > 0 {
		fmt.Printf("\033[s\033[%dB\r[%s] %3d%%  %s %s\033[u", taskLine, bar, percent, label, message)
	} else {
		fmt.Printf("\r[%s] %3d%%  %s %s", bar, percent, label, message)
	}
	progressActive = true
	progressLabel = label
}

func tryParseProgress(content string) *jsonStatus {
	var status jsonStatus
	if err := json.Unmarshal([]byte(content), &status); err != nil {
		return nil
	}
	if status.Status == "" {
		return nil
	}
	return &status
}

func broadcast(content string) {
	content = strings.TrimSpace(content)
	if content == "" {
		return
	}

	entry := LogEntry{
		Content: content,
		Time:    time.Now().Format("15:04:05"),
	}

	logMutex.Lock()
	logHistory = append(logHistory, entry)
	if len(logHistory) > 500 {
		logHistory = logHistory[len(logHistory)-500:]
	}
	logMutex.Unlock()

	if status := tryParseProgress(entry.Content); status != nil {
		if !jsonOutput {
			renderProgressLine(status)
		}
	} else {
		if progressActive {
			fmt.Println()
			progressActive = false
		}
		if !jsonOutput {
			log.Printf("[LOG] %s", entry.Content)
		}
	}
}



func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}



func logsHandler(w http.ResponseWriter, r *http.Request) {
	lastIndex := 0
	if query := r.URL.Query().Get("lastIndex"); query != "" {
		if i, err := strconv.Atoi(query); err == nil {
			lastIndex = i
		}
	}

	logMutex.Lock()
	defer logMutex.Unlock()

	if lastIndex < 0 {
		lastIndex = 0
	}
	if lastIndex > len(logHistory) {
		lastIndex = len(logHistory)
	}

	resp := map[string]interface{}{
		"logs":      logHistory[lastIndex:],
		"nextIndex": len(logHistory),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func processOutput(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		line = strings.ReplaceAll(line, "\r", "\n")
		for _, part := range strings.Split(line, "\n") {
			clean := strings.TrimSpace(part)
			if clean != "" {
				broadcast(clean)
			}
		}
	}
}

func startHTTPServer() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, _ = filepath.EvalSymlinks(exePath)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/logs", logsHandler)
	mux.HandleFunc("/api/download", downloadHandler)
	
	log.Printf("===========================================")
	log.Printf("  Apple Music 后端服务")
	log.Printf("  下载器 (本地): %s", exePath)
	log.Printf("  服务端口：%d", port)
	log.Printf("===========================================")

	if _, err := os.Stat(exePath); err != nil {
		log.Printf("[致命错误] 找不到下载器: %s", exePath)
	}

	return http.ListenAndServe(fmt.Sprintf(":%d", port), corsMiddleware(mux))
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	type requestBody struct {
		Url       string `json:"url"`
		ExtraArgs string `json:"extraArgs"`
	}

	var req requestBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "无效的请求体", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Url) == "" {
		http.Error(w, "缺少 url 字段", http.StatusBadRequest)
		return
	}

	broadcast(">>> [PTY模式] 启动任务...")

	exePath, err := os.Executable()
	if err != nil {
		http.Error(w, "内部错误: 无法获取可执行文件路径", http.StatusInternalServerError)
		return
	}

	workingDir, err := os.Getwd()
	if err != nil {
		http.Error(w, "内部错误: 无法获取当前工作目录", http.StatusInternalServerError)
		return
	}

	// 构建命令参数
	cmdArgs := []string{"--json-output"}
	if strings.TrimSpace(req.ExtraArgs) != "" {
		cmdArgs = append(cmdArgs, req.ExtraArgs)
	}
	cmdArgs = append(cmdArgs, req.Url)
	
	cmd := exec.Command(exePath, cmdArgs...)
	cmd.Env = os.Environ()
	cmd.Dir = workingDir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "内部错误: 无法读取 stdout", http.StatusInternalServerError)
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		http.Error(w, "内部错误: 无法读取 stderr", http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		http.Error(w, "内部错误: 无法启动下载进程", http.StatusInternalServerError)
		return
	}

	go processOutput(stdout)
	go processOutput(stderr)

	go func() {
		err := cmd.Wait()
		if err != nil {
			broadcast(fmt.Sprintf(">>> 进程已安全退出 (错误: %v)", err))
			return
		}
		broadcast(">>> 进程已安全退出 (代码: 0)")
	}()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "started"})
}

func handleSingleMV(urlRaw string) {
	if core.Debug_mode {
		return
	}
	storefront, albumId := parser.CheckUrlMv(urlRaw)
	accountForMV, err := core.GetAccountForStorefront(storefront)
	if err != nil {
		if jsonOutput {
			printJSONError(fmt.Sprintf("MV 下载失败: %v", err))
		} else {
			fmt.Printf("MV 下载失败: %v\n", err)
		}
		core.SharedLock.Lock()
		core.Counter.Error++
		core.SharedLock.Unlock()
		return
	}

	core.SharedLock.Lock()
	core.Counter.Total++
	core.SharedLock.Unlock()
	if len(accountForMV.MediaUserToken) <= 50 {
		core.SharedLock.Lock()
		core.Counter.Error++
		core.SharedLock.Unlock()
		if jsonOutput {
			printJSONError("MV 下载失败: media-user-token 无效")
		}
		return
	}
	if _, err := exec.LookPath("mp4decrypt"); err != nil {
		core.SharedLock.Lock()
		core.Counter.Error++
		core.SharedLock.Unlock()
		if jsonOutput {
			printJSONError("MV 下载失败: 未找到 mp4decrypt")
		}
		return
	}

	mvInfo, err := api.GetMVInfoFromAdam(albumId, accountForMV, storefront)
	if err != nil {
		errMsg := fmt.Sprintf("获取 MV 信息失败: %v", err)
		if jsonOutput {
			printJSONError(errMsg)
		} else {
			fmt.Println(errMsg)
		}
		core.SharedLock.Lock()
		core.Counter.Error++
		core.SharedLock.Unlock()
		return
	}

	if jsonOutput {
		type JsonStatus struct {
			Status    string `json:"status"`
			TrackNum  int    `json:"trackNum"`
			TrackName string `json:"trackName"`
			AlbumName string `json:"albumName"`
			AlbumID   string `json:"albumId"`
		}
		statusJSON, _ := json.Marshal(JsonStatus{
			Status:    "start",
			TrackNum:  1,
			TrackName: mvInfo.Data[0].Attributes.Name,
			AlbumName: mvInfo.Data[0].Attributes.Name,
			AlbumID:   albumId,
		})
		fmt.Println(string(statusJSON))
	}

	var artistFolder string
	if core.Config.ArtistFolderFormat != "" {
		artistFolder = strings.NewReplacer(
			"{UrlArtistName}", core.LimitString(mvInfo.Data[0].Attributes.ArtistName),
			"{ArtistName}", core.LimitString(mvInfo.Data[0].Attributes.ArtistName),
			"{ArtistId}", "",
		).Replace(core.Config.ArtistFolderFormat)
	}
	sanitizedArtistFolder := core.ForbiddenNames.ReplaceAllString(artistFolder, "_")
	_, err = downloader.MvDownloader(albumId, core.Config.AlacSaveFolder, sanitizedArtistFolder, "", storefront, nil, accountForMV, nil, jsonOutput)

	if err != nil {
		core.SharedLock.Lock()
		core.Counter.Error++
		core.SharedLock.Unlock()
		if jsonOutput {
			printJSONError(fmt.Sprintf("MV 下载失败: %v", err))
		}
		return
	}
	core.SharedLock.Lock()
	core.Counter.Success++
	core.SharedLock.Unlock()

	if jsonOutput {
		type JsonStatusComplete struct {
			Status     string `json:"status"`
			TrackNum   int    `json:"trackNum"`
			TrackName  string `json:"trackName"`
			AlbumName  string `json:"albumName"`
			AlbumID    string `json:"albumId"`
			Percentage int    `json:"percentage"`
		}
		statusJSON, _ := json.Marshal(JsonStatusComplete{
			Status:     "complete",
			TrackNum:   1,
			TrackName:  mvInfo.Data[0].Attributes.Name,
			AlbumName:  mvInfo.Data[0].Attributes.Name,
			AlbumID:    albumId,
			Percentage: 100,
		})
		fmt.Println(string(statusJSON))
	}
}

func processURL(urlRaw string, wg *sync.WaitGroup, semaphore chan struct{}, currentTask int, totalTasks int) {
	if wg != nil {
		defer wg.Done()
	}
	if semaphore != nil {
		defer func() { <-semaphore }()
	}

	if totalTasks > 1 && !jsonOutput {
		fmt.Printf("[%d/%d] 开始处理: %s\n", currentTask, totalTasks, urlRaw)
	}

	var storefront, albumId string

	if strings.Contains(urlRaw, "/music-video/") {
		handleSingleMV(urlRaw)
		return
	}

	if strings.Contains(urlRaw, "/song/") {
		tempStorefront, _ := parser.CheckUrlSong(urlRaw)
		accountForSong, err := core.GetAccountForStorefront(tempStorefront)
		if err != nil {
			errMsg := fmt.Sprintf("获取歌曲信息失败 for %s: %v", urlRaw, err)
			if jsonOutput {
				printJSONError(errMsg)
			} else {
				fmt.Println(errMsg)
			}
			return
		}
		urlRaw, err = api.GetUrlSong(urlRaw, accountForSong)
		if err != nil {
			errMsg := fmt.Sprintf("获取歌曲链接失败 for %s: %v", urlRaw, err)
			if jsonOutput {
				printJSONError(errMsg)
			} else {
				fmt.Println(errMsg)
			}
			return
		}
		core.Dl_song = true
	}

	if strings.Contains(urlRaw, "/playlist/") {
		storefront, albumId = parser.CheckUrlPlaylist(urlRaw)
	} else {
		storefront, albumId = parser.CheckUrl(urlRaw)
	}

	if albumId == "" {
		errMsg := fmt.Sprintf("无效的URL: %s", urlRaw)
		if jsonOutput {
			printJSONError(errMsg)
		} else {
			fmt.Println(errMsg)
		}
		return
	}

	parse, err := url.Parse(urlRaw)
	if err != nil {
		errMsg := fmt.Sprintf("解析URL失败 %s: %v", urlRaw, err)
		if jsonOutput {
			printJSONError(errMsg)
		} else {
			log.Println(errMsg)
		}
		return
	}
	var urlArg_i = parse.Query().Get("i")
	err = downloader.Rip(albumId, storefront, urlArg_i, urlRaw, jsonOutput)

	if err != nil {
		errMsg := fmt.Sprintf("专辑下载失败: %s -> %v", urlRaw, err)
		if jsonOutput {
			printJSONError(errMsg)
		} else {
			fmt.Println(errMsg)
		}
	} else {
		if totalTasks > 1 && !jsonOutput {
			fmt.Printf("[%d/%d] 任务完成: %s\n", currentTask, totalTasks, urlRaw)
		}
	}
}

func runDownloads(initialUrls []string, isBatch bool) {
	var finalUrls []string

	for _, urlRaw := range initialUrls {
		if strings.Contains(urlRaw, "/artist/") {
			if !jsonOutput {
				fmt.Printf("正在解析歌手页面: %s\n", urlRaw)
			}
			artistAccount := &core.Config.Accounts[0]
			urlArtistName, urlArtistID, err := api.GetUrlArtistName(urlRaw, artistAccount)
			if err != nil {
				if !jsonOutput {
					fmt.Printf("获取歌手名称失败 for %s: %v\n", urlRaw, err)
				}
				continue
			}

			core.Config.ArtistFolderFormat = strings.NewReplacer(
				"{UrlArtistName}", core.LimitString(urlArtistName),
				"{ArtistId}", urlArtistID,
			).Replace(core.Config.ArtistFolderFormat)

			albumArgs, err := api.CheckArtist(urlRaw, artistAccount, "albums")
			if err != nil {
				if !jsonOutput {
					fmt.Printf("获取歌手专辑失败 for %s: %v\n", urlRaw, err)
				}
			} else {
				finalUrls = append(finalUrls, albumArgs...)
				if !jsonOutput {
					fmt.Printf("从歌手 %s 页面添加了 %d 张专辑到队列。\n", urlArtistName, len(albumArgs))
				}
			}

			mvArgs, err := api.CheckArtist(urlRaw, artistAccount, "music-videos")
			if err != nil {
				if !jsonOutput {
					fmt.Printf("获取歌手MV失败 for %s: %v\n", urlRaw, err)
				}
			} else {
				finalUrls = append(finalUrls, mvArgs...)
				if !jsonOutput {
					fmt.Printf("从歌手 %s 页面添加了 %d 个MV到队列。\n", urlArtistName, len(mvArgs))
				}
			}
		} else {
			finalUrls = append(finalUrls, urlRaw)
		}
	}

	if len(finalUrls) == 0 {
		if !jsonOutput {
			fmt.Println("队列中没有有效的链接可供下载。")
		}
		return
	}

	numThreads := 1
	if isBatch && core.Config.TxtDownloadThreads > 1 {
		numThreads = core.Config.TxtDownloadThreads
	}

	var wg sync.WaitGroup
	semaphore := make(chan struct{}, numThreads)
	totalTasks := len(finalUrls)

	if !jsonOutput {
		fmt.Printf("--- 开始下载任务 ---\n总数: %d, 并发数: %d\n--------------------\n", totalTasks, numThreads)
	}

	for i, urlToProcess := range finalUrls {
		wg.Add(1)
		semaphore <- struct{}{}
		go processURL(urlToProcess, &wg, semaphore, i+1, totalTasks)
	}

	wg.Wait()
}

func main() {
	core.InitFlags()
	pflag.BoolVar(&jsonOutput, "json-output", false, "启用JSON输出 (供给桌面App使用)")
	pflag.BoolVar(&serverMode, "server", false, "以 HTTP 服务模式启动")
	pflag.IntVar(&port, "port", 3000, "HTTP 服务端口")

	pflag.Usage = func() {
		fmt.Fprintf(os.Stderr, "用法: %s [选项] [url1 url2 ...]\n", os.Args[0])
		fmt.Println("如果没有提供URL，程序将进入交互模式。")
		fmt.Println("选项:")
		pflag.PrintDefaults()
	}

	pflag.Parse()

	if serverMode {
		if err := startHTTPServer(); err != nil {
			log.Fatalf("HTTP 服务启动失败: %v", err)
		}
		return
	}

	err := core.LoadConfig(core.ConfigPath)
	if err != nil {
		if os.IsNotExist(err) && core.ConfigPath == "config.yaml" {
			errMsg := "错误: 默认配置文件 config.yaml 未找到。"
			if jsonOutput {
				printJSONError(errMsg)
			} else {
				fmt.Println(errMsg)
				pflag.Usage()
			}
			return
		}
		errMsg := fmt.Sprintf("加载配置文件 %s 失败: %v", core.ConfigPath, err)
		if jsonOutput {
			printJSONError(errMsg)
		} else {
			fmt.Println(errMsg)
		}
		return
	}

	if core.OutputPath != "" {
		core.Config.AlacSaveFolder = core.OutputPath
		core.Config.AtmosSaveFolder = core.OutputPath
	}

	token, err := api.GetToken()
	if err != nil {
		if len(core.Config.Accounts) > 0 && core.Config.Accounts[0].AuthorizationToken != "" && core.Config.Accounts[0].AuthorizationToken != "your-authorization-token" {
			token = strings.Replace(core.Config.Accounts[0].AuthorizationToken, "Bearer ", "", -1)
		} else {
			errMsg := "获取开发者 token 失败。"
			if jsonOutput {
				printJSONError(errMsg)
			} else {
				fmt.Println(errMsg)
			}
			return
		}
	}
	core.DeveloperToken = token

	args := pflag.Args()
	if len(args) == 0 {
		if jsonOutput {
			printJSONError("JSON 模式下不支持交互式输入")
			return
		}

		fmt.Print("请输入专辑链接或txt文件路径: ")
		reader := bufio.NewReader(os.Stdin)
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		if input == "" {
			fmt.Println("未输入内容，程序退出。")
			return
		}

		if strings.HasSuffix(strings.ToLower(input), ".txt") {
			if _, err := os.Stat(input); err == nil {
				fileBytes, err := os.ReadFile(input)
				if err != nil {
					fmt.Printf("读取文件 %s 失败: %v\n", input, err)
					return
				}
				lines := strings.Split(string(fileBytes), "\n")
				var urls []string
				for _, line := range lines {
					trimmedLine := strings.TrimSpace(line)
					if trimmedLine != "" {
						urls = append(urls, trimmedLine)
					}
				}
				runDownloads(urls, true)
			} else {
				fmt.Printf("错误: 文件不存在 %s\n", input)
				return
			}
		} else {
			runDownloads([]string{input}, false)
		}
	} else {
		runDownloads(args, false)
	}

	if !jsonOutput {
		fmt.Printf("\n=======  [✔ ] Completed: %d/%d  |  [⚠ ] Warnings: %d  |  [✖ ] Errors: %d  =======\n", core.Counter.Success, core.Counter.Total, core.Counter.Unavailable+core.Counter.NotSong, core.Counter.Error)
		if core.Counter.Error > 0 {
			fmt.Println("部分任务在执行过程中出错，请检查上面的日志记录")
		}
	}
}

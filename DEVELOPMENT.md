# FN-Terminal 开发文档

## 项目概述

FN-Terminal 是一款基于飞牛 fnOS 的本地终端管理器应用，采用 FPK 格式打包，提供 Web 终端访问功能。

### 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Go + gorilla/websocket + creack/pty |
| 前端 | xterm.js 5.5.0 |
| 通信 | WebSocket (通过 fnOS 统一网关) |
| 打包 | FPK (fnOS Application Package) |

---

## 开发过程中遇到的问题与解决方案

### 1. FPK 文件格式问题

**问题描述：** 初始打包时直接使用 `tar -czf` 创建 tar.gz 文件作为 FPK，安装时报错 "解压app.tgz失败"。

**原因分析：** FPK 格式并非简单的 tar.gz，其内部结构要求：
- 根目录包含：`manifest`、`ICON.PNG`、`ICON_256.PNG`、`cmd/`、`config/`、`wizard/`、`app.tgz`
- `app.tgz` 内部文件不能有 `app/` 前缀，应直接是 `ui/`、`www/`、`server/` 等目录

**解决方案：**
```bash
# 正确的打包方式
cd app/
tar -czf ../app.tgz server ui www
cd ..
tar -czf fn-terminal.fpk .
```

---

### 2. 应用安装失败 - "本地用户已存在"

**问题描述：** 安装时提示 "本地用户已存在"。

**原因分析：** `config/privilege` 中 `username` 和 `groupname` 设置为 `root`，与系统已有用户冲突。

**解决方案：** 使用应用专用用户名：
```json
{
    "defaults": {
        "run-as": "root"
    },
    "username": "fn-terminal",
    "groupname": "fn-terminal"
}
```

---

### 3. 应用无桌面图标和打开按钮

**问题描述：** 应用安装后无桌面图标，应用商店显示 "停用" 而非 "打开"。

**原因分析：** 多个配置问题导致：

#### 3.1 ui/config 的 key 格式错误
`app/ui/config` 中的 key 必须与 `manifest` 中的 `desktop_applaunchname` 完全一致。

#### 3.2 type 字段选择错误
- `type: "url"` - 在新标签页打开，适用于直接端口访问
- `type: "iframe"` - 在桌面窗口内加载，适用于 CGI 或网关模式

#### 3.3 缺少必要字段
- `service_port` - 应用监听端口
- `checkport` - 是否检查端口占用
- `install_dep_apps` - 依赖应用

**解决方案：**
```yaml
# manifest
desktop_applaunchname=fn-terminal.Application
service_port=7681
checkport=true
```

```json
// app/ui/config
{
    ".url": {
        "fn-terminal.Application": {
            "title": "Terminal",
            "icon": "images/icon_{0}.png",
            "type": "iframe",
            "protocol": "",
            "gatewaySocket": "app.sock",
            "gatewayPrefix": "/app/fn-terminal",
            "url": "/app/fn-terminal",
            "allUsers": true
        }
    }
}
```

---

### 4. CGI 方案无法保持会话状态

**问题描述：** 使用 CGI 方式执行命令时，每次请求独立，无法保持：
- 当前工作目录 (pwd)
- 环境变量
- 交互命令（如 top、vim）

**原因分析：** CGI 是请求-响应模式，每次 HTTP 请求都会创建新的进程，无法维持状态。

**解决方案：** 改用 WebSocket + node-pty / Go pty 方案，建立持久连接。

---

### 5. Node.js 方案体积过大

**问题描述：** 使用 Node.js + node-pty 时，FPK 体积达到 68MB。

**原因分析：** 需要内嵌完整的 Node.js 运行时和 node_modules（包含 native 绑定）。

**解决方案：** 改用 Go 语言实现，编译为静态二进制，FPK 体积降至 2.5MB。

---

### 6. WebSocket 无法通过 CGI 代理工作

**问题描述：** 使用 `type: "iframe"` + CGI 路径时，WebSocket 连接失败。

**原因分析：** fnOS 的 CGI 代理 (`/cgi/ThirdParty/`) 不支持 WebSocket 协议升级。

**解决方案：** 使用 fnOS 统一网关（需要 V1.1.3100+）：
- 配置 `gatewaySocket` 使用 Unix Socket
- 配置 `gatewayPrefix` 注册网关路由
- 网关自动支持 HTTP 和 WebSocket 转发

---

### 7. 统一网关 404 错误

**问题描述：** 配置网关后访问显示 "404 page not found"。

**原因分析：** Go 服务器未正确处理网关前缀路径。

**解决方案：** 使用 `http.StripPrefix` 处理路径：
```go
http.Handle("/app/fn-terminal/", 
    http.StripPrefix("/app/fn-terminal", 
        http.FileServer(http.Dir(httpDir))))
http.HandleFunc("/app/fn-terminal/ws", handleWebSocket)
```

---

### 8. 统一网关重定向循环

**问题描述：** 访问时浏览器提示 "重定向你太多次"。

**原因分析：** 路由处理逻辑导致无限重定向。

**解决方案：** 简化路由处理，避免重复注册和重定向逻辑。

---

### 9. 终端无颜色显示

**问题描述：** `ls` 命令输出无颜色，所有文件显示为白色。

**原因分析：** 通过 `exec.Command(shell)` 启动的 shell 未加载用户 profile 文件（`.bashrc`、`.profile`），缺少颜色别名配置。

**解决方案：**
1. 使用登录 shell：`exec.Command(shell, "-l")`
2. 设置环境变量：
```go
cmd.Env = append(os.Environ(),
    "TERM=xterm-256color",
    "COLORTERM=truecolor",
    "FORCE_COLOR=1",
    "CLICOLOR=1",
    "LS_COLORS=rs=0:di=01;34:ln=01;36:...",
)
```

---

### 10. 移动端字体大小无法调节

**问题描述：** 移动设备无物理键盘，无法使用快捷键调节字体大小。

**解决方案：** 添加移动端浮动控制按钮：
- 使用 CSS `@media (hover: none) and (pointer: coarse)` 检测触屏设备
- 实现折叠式控件：箭头 → 字体图标 → 调节按钮
- 使用 `touchstart` 事件 + `preventDefault()` 防止输入法隐藏

---

### 11. 移动端控件遮挡终端内容

**问题描述：** 浮动按钮遮挡终端文字。

**解决方案：**
- 默认隐藏所有控件，仅显示展开箭头
- 点击箭头后逐级展开
- 点击非控件区域自动收起

---

### 12. 顶部内边距影响自适应高度

**问题描述：** 添加 `padding-top` 后，xterm.js 的自适应计算出错，终端高度减少。

**原因分析：** xterm.js 的 FitAddon 根据容器尺寸计算行列数，padding 会减少可用空间。

**解决方案：** 使用 `margin-top` + `height: calc(100% - 8px)` 替代 `padding-top`。

---

### 13. 断开连接后自动重连问题

**问题描述：** 断开连接后 3 秒自动重连，用户无法感知断开状态。

**解决方案：**
- 移除自动重连逻辑
- 显示断开提示和 "按任意键重新连接"
- 使用 `terminal.onData()` 监听按键触发重连

---

## 项目结构

```
fn-terminal/
├── app/
│   ├── server/
│   │   └── terminal-server    # Go 编译的二进制文件
│   ├── ui/
│   │   ├── config             # 应用入口配置
│   │   ├── images/
│   │   │   ├── icon_64.png
│   │   │   └── icon_256.png
│   │   └── index.cgi          # CGI 脚本（备用）
│   └── www/
│       ├── index.html
│       ├── css/style.css
│       └── js/main.js
├── cmd/
│   ├── main                   # 启停脚本
│   ├── install_init
│   ├── install_callback
│   ├── upgrade_init
│   ├── upgrade_callback
│   ├── uninstall_init
│   ├── uninstall_callback
│   ├── config_init
│   └── config_callback
├── config/
│   ├── privilege              # 权限配置
│   └── resource               # 资源配置
├── wizard/
│   ├── install
│   ├── uninstall
│   └── config
├── manifest                   # 应用清单
├── ICON.PNG
├── ICON_256.PNG
└── LICENSE
```

---

## 环境变量

Go 服务器使用以下环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SOCKET_PATH` | Unix Socket 路径 | `/var/apps/fn-terminal/target/app.sock` |
| `HTTP_DIR` | 静态文件目录 | `../www` |
| `SHELL` | 默认 shell | `/bin/bash` |
| `HOME` | 用户主目录 | `/root` |

---

## 快捷键

### 桌面端
- `Ctrl+Shift+U` - 增大字体
- `Ctrl+Shift+D` - 减小字体
- `Ctrl+Shift+R` - 重置字体大小

### 移动端
- 右下角折叠控件按钮
- 点击箭头展开 → 点击 Aa 显示调节按钮

---

## 版本要求

- fnOS V1.1.3100+（统一网关支持）
- 支持 x86_64 架构

---

## 构建命令

```bash
# Go 编译（使用构建脚本）
cd app/server/src
./build.sh

# 或手动编译
cd app/server/src
go mod tidy
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o ../terminal-server -ldflags="-s -w" main.go

# 打包 FPK
cd ../../../
tar -czf fpk_build/app.tgz -C app server ui www
tar -czf fn-terminal.fpk -C fpk_build .
```

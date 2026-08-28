# My MCP Servers

自定义的 MCP (Model Context Protocol) 服务器集合，用于增强 AI 工具的能力。

## 项目简介

本项目包含两个相互配合的 MCP 服务器：

1. **gradle-manager-mcp** - 下载和管理 Gradle 依赖的源码 JAR
2. **jar_reader_mcp** - 读取 JAR 文件中的源代码和其他文件

### 主要功能

- 下载第三方库的源码
- 读取和分析 JAR 文件中的代码
- 搜索 JAR 文件中的类和文件
- 管理本地 Gradle 缓存中的源码

## 快速开始

### 前置要求

- Node.js (v16 或更高版本)
- npm 或 yarn
- (可选) Gradle - 如果要使用 Gradle CLI 下载源码

### 安装步骤

1. 克隆仓库
```bash
git clone <repository-url>
cd my-mcp-servers
```

2. 安装依赖并构建
```bash
# 安装 gradle-manager-mcp
cd gradle-manager-mcp
npm install
npm run build

# 安装 jar_reader_mcp
cd ../jar_reader_mcp
npm install
npm run build
```

## MCP 服务器配置

### Claude Desktop 配置

将以下配置添加到 Claude Desktop 配置文件中：

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gradle-manager-mcp": {
      "command": "node",
      "args": ["D:/Projects/my-mcp-servers/gradle-manager-mcp/dist/index.js"],
      "type": "stdio"
    },
    "jar_reader_mcp": {
      "command": "node",
      "args": ["D:/Projects/my-mcp-servers/jar_reader_mcp/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

**注意**: 请将 `D:/Projects/my-mcp-servers` 替换为你实际的项目路径。

## 使用指南

### 工作流程

这两个 MCP 服务器配合使用的典型工作流程：

```
1. 使用 gradle_find_source 查找源码 JAR
2. 如果未找到，使用 gradle_download_single_source 下载
3. 使用 jar_open 打开 JAR 文件
4. 使用 jar_* 系列工具读取、搜索和分析
5. 使用 jar_close 关闭 JAR 文件
```

### 示例：查看第三方库源码

假设你想查看 `com.google.code.gson:gson:2.13.2` 的源码：

1. **查找源码**
```typescript
gradle_find_source({
  coordinate: "com.google.code.gson:gson:2.13.2",
  gradleUserHome: "D:/java/gradle_repo"
})
```

2. **如果未找到，下载源码**
```typescript
gradle_download_single_source({
  coordinate: "com.google.code.gson:gson:2.13.2"
})
```

3. **打开 JAR 文件**
```typescript
jar_open({
  jarPath: "D:/java/gradle_repo/caches/modules-2/files-2.1/com.google.code.gson/gson/2.13.2/hash/gson-2.13.2-sources.jar"
})
```

4. **搜索文件**
```typescript
jar_search_files({
  pattern: "*Gson*.java"
})
```

5. **读取文件内容**
```typescript
jar_read_file({
  filePath: "com/google/gson/Gson.java"
})
```

6. **搜索代码内容**
```typescript
jar_search_content({
  pattern: "public class Gson",
  fileExtensions: [".java"]
})
```

7. **关闭 JAR**
```typescript
jar_close()
```

## 详细文档

### gradle-manager-mcp

详见: [gradle-manager-mcp/README.md](gradle-manager-mcp/README.md)

**可用工具**:
- `gradle_download_sources` - 下载整个 Gradle 项目的所有源码
- `gradle_download_single_source` - 下载单个 artifact 的源码
- `gradle_find_source` - 查找已缓存的源码 JAR
- `gradle_list_cached_sources` - 列出所有已缓存的源码
- `gradle_get_cache_info` - 获取 Gradle 缓存信息

### jar_reader_mcp

详见: [jar_reader_mcp/README.md](jar_reader_mcp/README.md)

**可用工具**:
- `jar_open` - 打开 JAR 文件
- `jar_list_files` - 列出 JAR 中所有文件
- `jar_read_file` - 读取指定文件内容
- `jar_search_files` - 按文件名搜索
- `jar_search_content` - 搜索文件内容
- `jar_get_file_info` - 获取文件信息
- `jar_close` - 关闭 JAR 文件

## 常见问题

### Q: 为什么需要这两个 MCP 服务器？

A:
- `gradle-manager-mcp` 负责下载和管理 Gradle 依赖的源码 JAR
- `jar_reader_mcp` 负责读取和分析 JAR 文件中的内容

两者配合使用可以让你方便地查看和分析第三方库的源代码。

### Q: 如何自定义 Gradle 用户目录？

A: 大多数工具都支持 `gradleUserHome` 参数，可以指定自定义的 Gradle 缓存路径：

```typescript
gradle_find_source({
  coordinate: "com.example:lib:1.0.0",
  gradleUserHome: "/custom/path/to/gradle"
})
```

### Q: JAR 文件路径必须是绝对路径吗？

A: 是的，`jar_open` 工具要求提供 JAR 文件的绝对路径。

### Q: 可以读取编译后的 .class 文件吗？

A: 不可以，`jar_reader_mcp` 不支持字节码反编译。你需要源码 JAR 文件（通常以 `-sources.jar` 结尾）。

## 技术栈

- **TypeScript** - 主要开发语言
- **@modelcontextprotocol/sdk** - MCP SDK
- **axios** - HTTP 请求（用于下载源码）
- **yauzl** - ZIP/JAR 文件解析

## 开发

### 项目结构

```
my-mcp-servers/
├── .gitignore
├── README.md
├── README.en.md
├── gradle-manager-mcp/
│   ├── src/
│   ├── dist/
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
└── jar_reader_mcp/
    ├── src/
    ├── dist/
    ├── package.json
    ├── tsconfig.json
    └── README.md
```

### 构建步骤

每个子项目都有独立的构建流程：

```bash
cd gradle-manager-mcp  # 或 jar_reader_mcp
npm install
npm run build
```

### 测试

每个子项目都可以独立测试：

```bash
cd gradle-manager-mcp  # 或 jar_reader_mcp
npm start
```

## 贡献

欢迎贡献！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 创建 Pull Request

## 许可证

本项目采用 MIT 许可证 - 详见 LICENSE 文件。

## 联系方式

如有问题或建议，请提交 Issue 或 Pull Request。

---

**注意**: 请确保在配置 MCP 服务器时使用正确的绝对路径，否则服务器无法正常工作。

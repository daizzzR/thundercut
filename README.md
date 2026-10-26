# leiting extension

看着看着，突然进入新宿决战。

一个免费开源的 **Chrome / Edge 浏览器整活扩展**，在观看网页视频时，随机插入你选择的本地短片。

**[下载 ZIP](https://github.com/daizzzR/leiting-extension/archive/refs/heads/main.zip)** · [详细使用说明](docs/USAGE.md) · [反馈问题](https://github.com/daizzzR/leiting-extension/issues)

## 有什么好玩的？

- **随机切入**：默认在符合条件的视频累计播放 1–15 秒后触发，同一视频自动触发一次。
- **随心换片**：支持导入本地 MP4，也能调整等待时间和触发概率。
- **原地整活**：只覆盖视频区域，不跳转页面，保留原片进度。
- **本机播放**：无需账号，工具不上传视频或浏览记录。

## 安装：四步搞定

1. 下载上方 ZIP 并解压。
2. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`。
3. 开启「开发者模式」，点击「加载已解压的扩展程序」。
4. 选择解压目录中的 **`extension` 文件夹**，刷新视频网页即可。

## 怎么用？

点击浏览器工具栏中的扩展图标，开启随机彩蛋；点「立即试一次」可手动触发。在「更换短片 · 调整触发规则」中导入自己的视频。

彩蛋播完停在结尾，原片保持暂停。按 **Esc / Alt+Shift+R**，或点「恢复原视频」即可返回。

适用于常见 HTML5 视频；不同网站、全屏及画中画等模式可能不兼容，尚未完成 Bilibili 等真实站点的兼容性验收。仅在自己或明确同意的人的浏览器中使用。

## 视频出处与开源说明

默认 MP4 出处：[B站 BV1iL8b6SEjU](https://www.bilibili.com/video/BV1iL8b6SEjU/)。

原创代码采用 [MIT 许可证](LICENSE)。视频、音乐、漫画图标及角色形象等第三方素材的权利归相关权利人所有，不在 MIT 授权范围内。免费、开源及注明出处不等于获得素材授权；使用或转载前请确认相应权利。完整声明及权利反馈方式见 [版权说明](docs/COPYRIGHT.md)。

欢迎 Star、Fork 和提交 Pull Request！开发与测试说明见 [TESTING.md](TESTING.md)。

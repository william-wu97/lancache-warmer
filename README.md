# lancache-warmer

配合 [lancache](https://lancache.net/) 使用的**游戏缓存预热框架**。

在你玩之前，把游戏内容提前灌进局域网缓存；真正安装时走千兆内网，不占公网带宽。

---

## 为什么不用现成方案

之前用 [SteamPrefill](https://github.com/tpill90/steam-lancache-prefill) + `lancache-dns`，在国内外网络环境下卡在三个地方：

| 问题 | 现象 |
|---|---|
| CM 连接不稳定 | 同环境实测 0/5~2/10 成功率，失败全在登录阶段，5 个 Cell 全部超时 |
| 公网 CDN 返 403 | Steam 返回的 CDN 列表里混着公网节点，被拒后要逐个重试 |
| 凭据无法复用 | 保存的 account.config 是加密 blob，换语言实现就读不了 |

更根本的是 DNS 那一层：`cache-domains` 上游的 `steam.txt` 现在只剩 `lancache.steamcontent.com` 一行，第三方工具查 CDN 列表时拿到的全是公网 IP，**请求根本没经过缓存**——下载日志显示成功，缓存里一个字节没有。

## 本项目的做法

```
面板触发 → provider 拉内容清单 → 按 chunk 拉取 → DNS 指向本机 → lancache 命中或回源
                                                                     ↑
                                                              内容只在这里落盘
```

三条关键决策：

1. **DNS 自己管** — 用 dnsmasq 对内容域名做子域通配（`address=/steamcontent.com/<NAS_IP>`），不依赖任何外部域名列表
2. **引擎用官方协议库** — 稳定性比 SteamPrefill 高一个数量级，且能识别并跳过对国内 IP 返 403 的公网节点
3. **流式丢弃** — chunk 读完即弃，客户端侧峰值磁盘占用为 0

## 支持的平台

| 平台 | 状态 | 说明 |
|---|---|---|
| Steam | ✅ 已实现 | 有成熟的第三方协议库，可纯程序化填充 |
| Epic | ⬜ 未实现 | 无公开协议，需运行客户端 |
| Battle.net | ⬜ 未实现 | 同上 |
| EA / Riot | ⬜ 未实现 | 同上 |

lancache 的**缓存层**是多平台的——任何 HTTP 流量加几行 DNS 记录就能覆盖。
但「预填充」要求脱离客户端主动拉内容，目前只有 Steam 能做到。

欢迎提交新的 provider。参考 `src/providers/steam/` 的结构实现同样的接口即可。

## 项目状态

> **开发中。** 引擎各模块已完成并有测试覆盖；HTTP 接口与 Web 面板尚未接上。
> 当前代码不能开箱运行，但核心链路（登录 → 清单 → 下载）已可编程调用。

已完成：

- [x] Node 服务骨架 + 配置外置
- [x] 缓存目录扫描（统计占用、反查已缓存 depot）
- [x] 游戏库存储与增删查
- [x] 封面图本地缓存（并发去重、超时控制）
- [x] 每日定时调度
- [x] Steam 凭据本地存储（600 权限、原子写入）
- [x] 扫码登录（steam-session，仅 SteamClient 平台）
- [x] app → depot → manifest → chunk 清单（含 oslist 过滤、去重、重试）
- [x] chunk 流式下载 + 并发池（读完即弃，全程不落盘）
- [x] 预填充流程编排（失败重试、多 CDN 轮转、可中断）

进行中：

- [ ] HTTP API（把引擎接到 Web 层）
- [ ] Web 面板
- [ ] 部署文档与 compose 模板

> 关于「是否已缓存」的判定：本项目**不解析** Steam 的 `appmanifest_*.acf`。
> 那需要访问客户端的库目录，而 warmer 跑在 NAS 上。改为直接扫描 lancache
> 的磁盘结构（`<cache>/steam/depot_<id>/`），从缓存侧反推，不依赖客户端。

## 快速开始

> 待第一版可用后补充。

```bash
git clone https://github.com/william-wu97/lancache-warmer.git
cd lancache-warmer
cp .env.example .env      # 修改 NAS_IP 与存储路径
docker compose up -d
```

## 环境要求

| 项 | 要求 |
|---|---|
| 主机 | x86_64，能跑 Docker，建议内存 ≥ 2 GB |
| 依赖 | lancache（monolithic）+ dnsmasq，均以容器方式提供 |
| 磁盘 | 缓存空间按你实际游戏库大小规划，建议留 500 GB 以上 |
| 网络 | 客户端与 NAS 在同一局域网 |

## 和 lancache 的关系

本项目**不含缓存服务本身**，只负责「把内容提前灌进缓存」。完整的链路是：

```
lancache-warmer（预热）  →  lancache（缓存）  →  dnsmasq（劫持）
```

lancache 与 lancache-dns 是 [lancachenet](https://github.com/lancachenet) 的项目，版权归原作者。

## 免责声明

- 仅用于个人自建缓存，**不要用于商业分发**
- 预填充需要在本地保存 Steam 登录凭据（refresh token），请自行评估风险
- 请遵守 Steam 用户协议与当地法律

## License

[MIT](LICENSE)

# 创业板 × 中证红利｜市场风格观察仪表盘

基于创业板指数（399006.SZ）与中证红利指数（000922.SH）历史收盘数据计算相对比值，
辅助观察成长与红利风格变化的个人研究工具。**不提供买卖或仓位调整建议。**

技术栈：React 18 + TypeScript + Vite + Tailwind CSS + Apache ECharts + GitHub Actions + GitHub Pages。
无后端服务器、无数据库：历史行情以 JSON 形式随项目保存，网页只读静态文件。

## 本地启动

```bash
npm install
npm run dev        # 开发环境 http://localhost:5173
npm run build      # 构建产物输出到 dist/
npm run preview    # 本地预览构建产物
```

首次 clone 仓库时 `public/data/` 已包含全部历史数据，无需初始化即可运行。

## 数据初始化（仅首次，本地无数据时）

```bash
npm run data:init
```

- 拉取两个指数的全部可用历史（创业板指自 2010-06-01 起有行情；2009-10-30 ~ 2010-05 期间中证红利有数据、创业板指无数据，比值保留空白，不编造数据）。
- 生成 `public/data/historical.json`（历史记录）与 `public/data/metadata.json`（元数据：来源、口径、最新交易日、版本、记录数）。
- 若 `historical.json` 已存在会中止，防止误覆盖。

## 手动增量更新

```bash
npm run data:update          # 只请求本地最新日期前 30 个自然日（覆盖 5 个交易日重查窗口与长假）
npm run data:validate        # 全量完整性检查（与数据源比对缺口/修订）
npm run data:validate -- --fix   # 检查并自动合并修复
```

更新逻辑要点：重查近 5 个交易日以吸收数据源历史修正；日期去重升序；比值重算（6 位小数精度）；
校验失败不写入（保留旧版本）；临时文件写入后原子替换；重复运行不产生重复记录。

## 自动更新（GitHub Actions）

`.github/workflows/update-data.yml`：

- 每个交易日北京时间 15:30 与 16:30 各尝试一次（UTC cron `30 7,8 * * 1-5`，Actions 定时可能延迟）。
- 更新成功且数据变化 → 自动提交 JSON → 推送触发 `deploy.yml` 重新部署 Pages。
- 更新失败 → 保留线上旧版本，Actions 中给出 warning。
- 支持在 Actions 页面手动运行（workflow_dispatch）。

`.github/workflows/validate-data.yml`：每周日自动全量完整性检查并自动修复缺口。

## GitHub Pages 部署步骤

1. 在 GitHub 创建仓库并推送本项目：

   ```bash
   git init && git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git add . && git commit -m "init" && git push -u origin main
   ```

2. 仓库 Settings → Pages → Build and deployment → Source 选择 **GitHub Actions**。
3. 等待 `Deploy to GitHub Pages` 工作流完成，访问
   `https://<你的用户名>.github.io/<仓库名>/`。
4. 之后每次推送 main 分支自动构建部署；数据更新工作流提交数据后也会自动触发。

`vite.config.ts` 使用相对 base（`./`），任意仓库名/子路径均可直接工作。

## 数据来源与更换

默认数据源适配层（`scripts/datasource/`）：

| 优先级 | 数据商 | 接口 | 指数代码（数据商格式） | 说明 |
|---|---|---|---|---|
| 主源 | 东方财富 | push2his kline API（免密钥） | 399006 / 000922（secid 前缀 0/1） | 覆盖最全 |
| 备源 | 腾讯财经 | web.ifzq.gtimg.cn fqkline API（免密钥） | sz399006 / sh000922 | 主源失败自动降级；已与东财交叉校验一致 |

**更换数据源**：在 `scripts/datasource/` 中参照 `tencent.ts` 实现一个新适配器
（实现 `DataSourceAdapter` 接口的 `fetchChinext / fetchDividend`），注册到 `index.ts`
的适配器列表即可，初始化/更新/校验脚本无需改动。
用环境变量 `DATA_SOURCE=eastmoney|tencent` 可强制指定数据源。
如数据商需要密钥，通过环境变量注入，勿提交到仓库。

## 数据口径说明

- 相对比值 = 创业板指数收盘点位 ÷ 中证红利指数收盘点位（价格指数、未复权口径，收盘价参与计算）。
- 计算保留 6 位小数，界面展示 3 位小数；禁止用四舍五入后的展示值再计算。
- 0.3 / 0.7 为历史观察得到的研究参考阈值，非统计检验结论，不保证长期有效。
- 页面时间轴从 2009-10-30（创业板开市日）开始；创业板指正式行情自 2010-06-01 起，
  此前区间留白。

## 常见数据异常处理

| 现象 | 处理 |
|---|---|
| 数据源接口不可访问 | 自动降级到备源；全部失败时更新脚本以非 0 退出并保留旧数据 |
| 当日收盘数据尚未发布 | 保留上一有效交易日，不做补 0 或插值 |
| 数据源修订历史收盘价 | 更新脚本重查近 5 个交易日覆盖修正；更早的历史修订由每周完整性检查发现并合并 |
| historical.json 损坏 | 历史数据随 git 保存，`git checkout public/data` 恢复后重跑更新 |
| 发现早期缺口 | 运行 `npm run data:validate -- --fix` 自动补齐 |

## 项目结构

```text
src/
  components/       Header / MetricCards / TimeRangeSelector / ExplanationModal / charts/MainChart
  hooks/            useMarketData（数据加载与版本检查）/ useMediaQuery / useReducedMotion
  services/         marketData/loader（metadata → historical 版本化加载）
  utils/            calculations/ratio（比值、状态、极值）/ formatting/format
  types/            market.ts（脚本与前端共用类型）
scripts/
  datasource/       eastmoney.ts（主源）/ tencent.ts（备源）/ index.ts（降级选择器）
  lib/dataCore.ts   合并、校验、原子写入
  initialize-data.ts / update-data.ts / validate-data.ts
public/data/        historical.json + metadata.json（随仓库保存）
.github/workflows/  update-data.yml / deploy.yml / validate-data.yml
```

## 已知限制

- GitHub Actions 定时任务可能延迟，不承诺每个交易日 15:30 准点更新。
- 历史数据以数据商当前提供口径为准，极早期数据可能存在数据商侧修正。
- 比值基于价格指数，未考虑分红再投资；作为风格相对强弱观察工具使用，不构成估值判断。

# Height-Translate-Backend-Worker

将 `Height-Translate-Backend-Tiled` 迁移到 Cloudflare Workers 的版本。  
原项目：[`Height-Translate-Backend-Tiled`](https://github.com/Mrright024/Height-Translate-Backend-Tiled)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Mrright024/Height-Translate-Backend-Worker)

## 功能

- 保持原接口路径与响应结构：
- `GET /health`
- `GET /api/v1/geoid/undulation?lat=...&lon=...`
- `POST /api/v1/geoid/undulation/batch`
- 保持原插值逻辑：
- `1x1` 切片
- 每片 `61x61`（`uint16_le`）
- 双线性插值
- 批量请求按切片分组，减少重复读取
- 切片从 Cloudflare R2 读取

## R2 数据布局

默认读取前缀是 `tiles`，因此对象键应为：

- `tiles/meta.json`
- `tiles/n39/e116.bin`
- `tiles/s01/w001.bin`

可通过变量 `HTB_R2_TILE_PREFIX` 修改前缀。

## 本地开发

```bash
npm install
npm run dev
```

## 部署

1. 修改 `wrangler.json` 中的 R2 桶名：

```json
{
  "r2_buckets": [
    {
      "binding": "TILES_BUCKET",
      "bucket_name": "your-r2-bucket-name",
      "preview_bucket_name": "your-r2-bucket-name-preview"
    }
  ]
}
```

2. 部署：

```bash
npm run deploy
```

## 环境变量

在 `wrangler.json` 的 `vars` 中配置：

- `HTB_GEOID_MODEL`：默认 `egm2008-1`
- `HTB_GEOIDEVAL_BIN`：默认 `TileInterpolator`（仅用于 `/health` 兼容字段）
- `HTB_R2_TILE_PREFIX`：默认 `tiles`
- `HTB_MAX_BATCH_SIZE`：默认 `100`
- `HTB_GEOID_TILE_CACHE_SIZE`：默认 `512`
- `HTB_CORS_ALLOW_ORIGINS`：默认 `*`，支持逗号分隔多个域名

## 返回示例

`GET /api/v1/geoid/undulation?lat=39.9042&lon=116.4074`

```json
{
  "model": "egm2008-1",
  "latitude": 39.9042,
  "longitude": 116.4074,
  "undulation_m": -9.123456,
  "unit": "m",
  "source": "GeographicLib GeoidEval"
}
```

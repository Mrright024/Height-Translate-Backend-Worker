interface Env {
  TILES_BUCKET: R2Bucket;
  HTB_GEOID_MODEL?: string;
  HTB_GEOIDEVAL_BIN?: string;
  HTB_R2_TILE_PREFIX?: string;
  HTB_MAX_BATCH_SIZE?: string;
  HTB_GEOID_TILE_CACHE_SIZE?: string;
  HTB_CORS_ALLOW_ORIGINS?: string;
}

interface RuntimeConfig {
  model: string;
  geoidevalBin: string;
  tilePrefix: string;
  maxBatchSize: number;
  tileCacheSize: number;
  corsOrigins: string[];
}

interface TileMeta {
  model: string;
  tile_degree: number;
  samples_per_degree: number;
  tile_width: number;
  tile_height: number;
  value_type: string;
  offset: number;
  scale: number;
}

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface GroupedPoint {
  index: number;
  latitude: number;
  lonNormalized: number;
}

const SAMPLES_PER_DEGREE = 60;
const TILE_GRID_SIZE = SAMPLES_PER_DEGREE + 1;
const TILE_VALUES_PER_FILE = TILE_GRID_SIZE * TILE_GRID_SIZE;
const TILE_BYTES_PER_FILE = TILE_VALUES_PER_FILE * 2;
const FLOAT_EPS = 1e-12;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class GeoidServiceError extends Error {}

class LruTileCache {
  private readonly map = new Map<string, Uint16Array>();
  private maxSize = 512;

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }

  get(key: string): Uint16Array | undefined {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: Uint16Array): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }
}

const tileCache = new LruTileCache();
const tileMetaCache = new Map<string, TileMeta>();

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const config = buildConfig(env);
    tileCache.setMaxSize(config.tileCacheSize);
    const corsHeaders = buildCorsHeaders(request, config.corsOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      const url = new URL(request.url);
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/") {
        return jsonResponse(
          {
            service: "Height Translate Backend API",
            docs: "/docs",
            openapi: "/openapi.json",
          },
          200,
          corsHeaders,
        );
      }

      if (request.method === "GET" && pathname === "/health") {
        return jsonResponse(
          {
            status: "ok",
            model: config.model,
            geoideval_bin: config.geoidevalBin,
          },
          200,
          corsHeaders,
        );
      }

      if (request.method === "GET" && pathname === "/api/v1/geoid/undulation") {
        const latitude = parseBoundedNumber(url.searchParams.get("lat"), "lat", -90, 90);
        const longitude = parseBoundedNumber(url.searchParams.get("lon"), "lon", -180, 180);
        const undulation = await computeUndulation(env, config, latitude, longitude);
        return jsonResponse(
          buildUndulationResponse(config.model, latitude, longitude, undulation),
          200,
          corsHeaders,
        );
      }

      if (request.method === "POST" && pathname === "/api/v1/geoid/undulation/batch") {
        const points = await parseBatchBody(request);
        if (points.length > config.maxBatchSize) {
          throw new HttpError(
            400,
            `Batch size ${points.length} exceeds configured max_batch_size ${config.maxBatchSize}.`,
          );
        }

        const undulations = await computeBatchUndulations(env, config, points);
        const results = points.map((point, index) =>
          buildUndulationResponse(config.model, point.latitude, point.longitude, undulations[index]),
        );

        return jsonResponse(
          {
            model: config.model,
            count: results.length,
            results,
          },
          200,
          corsHeaders,
        );
      }

      return jsonResponse({ detail: "Not Found" }, 404, corsHeaders);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse({ detail: error.message }, error.status, corsHeaders);
      }
      if (error instanceof GeoidServiceError) {
        return jsonResponse({ detail: error.message }, 503, corsHeaders);
      }

      console.error("Unhandled worker error:", error);
      return jsonResponse({ detail: "Internal Server Error" }, 500, corsHeaders);
    }
  },
};

export default worker;

function buildConfig(env: Env): RuntimeConfig {
  return {
    model: sanitizeText(env.HTB_GEOID_MODEL, "egm2008-1"),
    geoidevalBin: sanitizeText(env.HTB_GEOIDEVAL_BIN, "TileInterpolator"),
    tilePrefix: normalizePrefix(sanitizeText(env.HTB_R2_TILE_PREFIX, "tiles")),
    maxBatchSize: parsePositiveInt(env.HTB_MAX_BATCH_SIZE, 100),
    tileCacheSize: parsePositiveInt(env.HTB_GEOID_TILE_CACHE_SIZE, 512),
    corsOrigins: parseCorsOrigins(env.HTB_CORS_ALLOW_ORIGINS),
  };
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function parseCorsOrigins(value: string | undefined): string[] {
  const raw = sanitizeText(value, "*");
  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length > 0 ? list : ["*"];
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

function buildCorsHeaders(request: Request, corsOrigins: string[]): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowAll = corsOrigins.includes("*");

  if (allowAll) {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin !== null && corsOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", corsOrigins[0] ?? "*");
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(payload: unknown, status: number, corsHeaders: Headers): Response {
  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

function parseBoundedNumber(
  raw: string | null,
  field: string,
  min: number,
  max: number,
): number {
  if (raw === null) {
    throw new HttpError(400, `Missing query parameter: ${field}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new HttpError(400, `Invalid number for ${field}`);
  }
  if (value < min || value > max) {
    throw new HttpError(400, `${field} must be within [${min}, ${max}]`);
  }
  return value;
}

async function parseBatchBody(request: Request): Promise<Coordinate[]> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }

  if (!isRecord(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  const pointsRaw = body.points;
  if (!Array.isArray(pointsRaw) || pointsRaw.length === 0) {
    throw new HttpError(400, "Field 'points' must be a non-empty array.");
  }

  return pointsRaw.map((item, index) => parsePoint(item, index));
}

function parsePoint(item: unknown, index: number): Coordinate {
  if (!isRecord(item)) {
    throw new HttpError(400, `points[${index}] must be an object.`);
  }

  const latitude = Number(item.latitude);
  const longitude = Number(item.longitude);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new HttpError(400, `points[${index}].latitude must be within [-90, 90].`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new HttpError(400, `points[${index}].longitude must be within [-180, 180].`);
  }

  return { latitude, longitude };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function computeUndulation(
  env: Env,
  config: RuntimeConfig,
  latitude: number,
  longitude: number,
): Promise<number> {
  const meta = await getTileMeta(env, config);
  const lonNormalized = normalizeLongitude(longitude);
  const tileLat = tileLatitude(latitude);
  const tileLon = tileLongitude(lonNormalized);
  const tileValues = await getTileValues(env, config, meta, tileLat, tileLon);
  return interpolate(tileValues, meta, tileLat, tileLon, latitude, lonNormalized);
}

async function computeBatchUndulations(
  env: Env,
  config: RuntimeConfig,
  points: Coordinate[],
): Promise<number[]> {
  const meta = await getTileMeta(env, config);
  const grouped = new Map<string, { tileLat: number; tileLon: number; entries: GroupedPoint[] }>();
  const results = new Array<number>(points.length);

  points.forEach((point, index) => {
    const lonNormalized = normalizeLongitude(point.longitude);
    const tileLat = tileLatitude(point.latitude);
    const tileLon = tileLongitude(lonNormalized);
    const key = `${tileLat}:${tileLon}`;
    const existing = grouped.get(key);

    if (existing !== undefined) {
      existing.entries.push({ index, latitude: point.latitude, lonNormalized });
      return;
    }

    grouped.set(key, {
      tileLat,
      tileLon,
      entries: [{ index, latitude: point.latitude, lonNormalized }],
    });
  });

  for (const group of grouped.values()) {
    const tileValues = await getTileValues(env, config, meta, group.tileLat, group.tileLon);
    for (const entry of group.entries) {
      results[entry.index] = interpolate(
        tileValues,
        meta,
        group.tileLat,
        group.tileLon,
        entry.latitude,
        entry.lonNormalized,
      );
    }
  }

  return results;
}

async function getTileMeta(env: Env, config: RuntimeConfig): Promise<TileMeta> {
  const cacheKey = `${config.model}|${config.tilePrefix}`;
  const cached = tileMetaCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const objectKey = buildObjectKey(config.tilePrefix, "meta.json");
  const object = await env.TILES_BUCKET.get(objectKey);
  if (object === null) {
    throw new GeoidServiceError(`Tile metadata not found: ${objectKey}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await object.text());
  } catch {
    throw new GeoidServiceError(`Tile metadata JSON is invalid: ${objectKey}`);
  }

  const meta = parseTileMeta(payload);
  validateTileMeta(meta, config);
  tileMetaCache.set(cacheKey, meta);
  return meta;
}

function parseTileMeta(payload: unknown): TileMeta {
  if (!isRecord(payload)) {
    throw new GeoidServiceError("Tile metadata must be a JSON object.");
  }

  const requiredFields = [
    "model",
    "tile_degree",
    "samples_per_degree",
    "tile_width",
    "tile_height",
    "value_type",
    "offset",
    "scale",
  ] as const;

  const missingFields = requiredFields.filter((field) => !(field in payload));
  if (missingFields.length > 0) {
    throw new GeoidServiceError(
      `Tile metadata is missing required fields: ${missingFields.join(", ")}`,
    );
  }

  return {
    model: String(payload.model),
    tile_degree: toInteger(payload.tile_degree, "tile_degree"),
    samples_per_degree: toInteger(payload.samples_per_degree, "samples_per_degree"),
    tile_width: toInteger(payload.tile_width, "tile_width"),
    tile_height: toInteger(payload.tile_height, "tile_height"),
    value_type: String(payload.value_type),
    offset: toNumber(payload.offset, "offset"),
    scale: toNumber(payload.scale, "scale"),
  };
}

function toInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new GeoidServiceError(`Tile metadata field '${field}' is invalid.`);
  }
  return parsed;
}

function toNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new GeoidServiceError(`Tile metadata field '${field}' is invalid.`);
  }
  return parsed;
}

function validateTileMeta(meta: TileMeta, config: RuntimeConfig): void {
  if (meta.model !== config.model) {
    throw new GeoidServiceError(
      `Tile metadata model '${meta.model}' does not match configured model '${config.model}'.`,
    );
  }
  if (meta.tile_degree !== 1) {
    throw new GeoidServiceError("Only 1x1 degree tile metadata is supported.");
  }
  if (meta.samples_per_degree !== SAMPLES_PER_DEGREE) {
    throw new GeoidServiceError(
      `Unexpected samples_per_degree=${meta.samples_per_degree}.`,
    );
  }
  if (meta.tile_width !== TILE_GRID_SIZE || meta.tile_height !== TILE_GRID_SIZE) {
    throw new GeoidServiceError(
      "Unexpected tile grid size. Expected 61x61 samples per tile.",
    );
  }
  if (meta.value_type.toLowerCase() !== "uint16_le") {
    throw new GeoidServiceError(
      `Unsupported tile value_type='${meta.value_type}', expected uint16_le.`,
    );
  }
}

async function getTileValues(
  env: Env,
  config: RuntimeConfig,
  meta: TileMeta,
  tileLat: number,
  tileLon: number,
): Promise<Uint16Array> {
  const cacheKey = `${meta.model}|${config.tilePrefix}|${tileLat}|${tileLon}`;
  const hit = tileCache.get(cacheKey);
  if (hit !== undefined) {
    return hit;
  }

  const objectKey = buildObjectKey(
    config.tilePrefix,
    `${latitudeKey(tileLat)}/${longitudeKey(tileLon)}.bin`,
  );
  const object = await env.TILES_BUCKET.get(objectKey);
  if (object === null) {
    throw new GeoidServiceError(`Tile file not found: ${objectKey}`);
  }

  const raw = await object.arrayBuffer();
  if (raw.byteLength !== TILE_BYTES_PER_FILE) {
    throw new GeoidServiceError(
      `Tile file has invalid size: ${objectKey} (expected ${TILE_BYTES_PER_FILE}, got ${raw.byteLength}).`,
    );
  }

  const decoded = decodeUint16Le(raw);
  tileCache.set(cacheKey, decoded);
  return decoded;
}

function buildObjectKey(prefix: string, suffix: string): string {
  return prefix.length > 0 ? `${prefix}/${suffix}` : suffix;
}

function decodeUint16Le(raw: ArrayBuffer): Uint16Array {
  const values = new Uint16Array(TILE_VALUES_PER_FILE);
  const view = new DataView(raw);
  for (let index = 0; index < TILE_VALUES_PER_FILE; index += 1) {
    values[index] = view.getUint16(index * 2, true);
  }
  return values;
}

function normalizeLongitude(lon: number): number {
  const normalized = ((((lon + 180) % 360) + 360) % 360) - 180;
  return normalized === 180 ? -180 : normalized;
}

function tileLatitude(lat: number): number {
  if (lat >= 90) {
    return 89;
  }
  if (lat <= -90) {
    return -90;
  }
  return Math.floor(lat);
}

function tileLongitude(lon: number): number {
  if (lon >= 180) {
    return -180;
  }
  return Math.floor(lon);
}

function latitudeKey(lat: number): string {
  const absValue = Math.abs(lat).toString().padStart(2, "0");
  return `${lat >= 0 ? "n" : "s"}${absValue}`;
}

function longitudeKey(lon: number): string {
  const absValue = Math.abs(lon).toString().padStart(3, "0");
  return `${lon >= 0 ? "e" : "w"}${absValue}`;
}

function interpolate(
  tileValues: Uint16Array,
  meta: TileMeta,
  tileLat: number,
  tileLon: number,
  latitude: number,
  lonNormalized: number,
): number {
  let x = (lonNormalized - tileLon) * SAMPLES_PER_DEGREE;
  let y = (latitude - tileLat) * SAMPLES_PER_DEGREE;

  if (x < 0 && Math.abs(x) < FLOAT_EPS) {
    x = 0;
  }
  if (y < 0 && Math.abs(y) < FLOAT_EPS) {
    y = 0;
  }

  x = clamp(x, 0, SAMPLES_PER_DEGREE);
  y = clamp(y, 0, SAMPLES_PER_DEGREE);

  const col = Math.min(Math.floor(x), SAMPLES_PER_DEGREE - 1);
  const row = Math.min(Math.floor(y), SAMPLES_PER_DEGREE - 1);
  const tx = x - col;
  const ty = y - row;

  const base = row * TILE_GRID_SIZE + col;
  const v00 = tileValues[base];
  const v10 = tileValues[base + 1];
  const v01 = tileValues[base + TILE_GRID_SIZE];
  const v11 = tileValues[base + TILE_GRID_SIZE + 1];

  const rawInterp =
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty;

  return meta.offset + meta.scale * rawInterp;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildUndulationResponse(
  model: string,
  latitude: number,
  longitude: number,
  undulation: number,
): Record<string, unknown> {
  return {
    model,
    latitude,
    longitude,
    undulation_m: undulation,
    unit: "m",
    source: "GeographicLib GeoidEval",
  };
}

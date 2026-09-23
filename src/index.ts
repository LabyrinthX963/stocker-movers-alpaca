import { Elysia } from "elysia";

const APCA_API_KEY_ID = process.env.APCA_API_KEY_ID!; //สมัคร alpaca ที่ https://alpaca.markets/ แล้ว generate มานะจ๊ะ
const APCA_API_SECRET_KEY = process.env.APCA_API_SECRET_KEY!;

const HEADERS = {
  "APCA-API-KEY-ID": APCA_API_KEY_ID,
  "APCA-API-SECRET-KEY": APCA_API_SECRET_KEY,
};

const MIN_PRICE = 0.1;
const MAX_PERCENT_CHANGE = 500;
const MAX_MESSAGE_LENGTH = 4000; // telegram ส่งได้ 4096 แต่จำกัดไว้ 4000 พอ
const EXCLUDE_SUFFIX = ["W", "WS", "R", "U"]; 
const EXCLUDE_SYMBOLS = [
  "MSTU", "MSTX", "MSTZ", "MSTC", "MSTB", "SMST",
];
// คำในชื่อบริษัทที่บ่งว่าเป็น leveraged/inverse ETF ไม่ใช่หุ้นแท้
const LEVERAGED_NAME_PATTERNS = [
  "2X", "3X", "-1X", "-2X", "-3X", "ULTRA", "DAILY", "BULL", "BEAR", "INVERSE", "LEVERAGED",
];

type Mover = { symbol: string; price: number; change: number; percent_change: number };
type Asset = { symbol: string; name: string; tradable: boolean; status: string; class: string };

let assetsCache = new Map<string, Asset>();
let assetsCacheTime = 0;
const ASSETS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getAssets(): Promise<Map<string, Asset>> {
  const now = Date.now();
  if (assetsCache.size > 0 && now - assetsCacheTime < ASSETS_CACHE_TTL_MS) {
    return assetsCache;
  }

  const res = await fetch(
    "https://paper-api.alpaca.markets/v2/assets?asset_class=us_equity&status=active",
    { headers: HEADERS }
  );

  if (!res.ok) {
    return assetsCache;
  }

  const list = (await res.json()) as Asset[];
  const map = new Map<string, Asset>();
  for (const a of list) map.set(a.symbol, a);

  assetsCache = map;
  assetsCacheTime = now;
  return map;
}

function isLeveragedName(name: string): boolean {
  const upper = name.toUpperCase();
  return LEVERAGED_NAME_PATTERNS.some((p) => upper.includes(p));
}

function isNoiseSymbol(symbol: string): boolean {
  if (symbol.includes(".")) return true;
  if (EXCLUDE_SYMBOLS.includes(symbol)) return true;
  return EXCLUDE_SUFFIX.some((suffix) => symbol.endsWith(suffix));
}

function formatSigned(n: number, decimals = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}`;
}

// เตรียมข้อความพร้อมส่งเข้า telegram 
function buildMessage(movers: Mover[], assets: Map<string, Asset>): string {
  const nowTH = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }) + " น.";
  const header = `📈 หุ้น US บวกแรง (${movers.length} ตัว ${nowTH})\n\n`;
  const lines: string[] = [];
  let total = header.length;
  let shown = 0;

  for (const m of movers) {
    const asset = assets.get(m.symbol);
    const name = asset?.name ?? "-";
    const line =
      `• ${m.symbol} (${name})\n` +
      `  ราคา $${m.price.toFixed(2)} | เปลี่ยน ${formatSigned(m.change)} | ${formatSigned(m.percent_change)}%\n`;

    if (total + line.length > MAX_MESSAGE_LENGTH - 60) {
      lines.push(`\n...และอีก ${movers.length - shown} ตัวที่เหลือ`);
      break;
    }

    lines.push(line);
    total += line.length;
    shown++;
  }

  return header + lines.join("\n");
}

async function getFilteredMovers(): Promise<{ movers: Mover[]; assets: Map<string, Asset> }> {
  const [moversRes, assets] = await Promise.all([
    fetch("https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50", {
      headers: HEADERS,
    }),
    getAssets(),
  ]);

  if (!moversRes.ok) {
    throw new Error(`Alpaca movers API error: ${moversRes.status}`);
  }

  const data = (await moversRes.json()) as { gainers: Mover[] };

  const filtered = data.gainers.filter((m) => {
    if (m.price < MIN_PRICE) return false;
    if (m.percent_change > MAX_PERCENT_CHANGE) return false;
    if (isNoiseSymbol(m.symbol)) return false;

    const asset = assets.get(m.symbol);
    if (!asset) return false; // ไม่เจอใน active us_equity list เลยตัดออก (กัน ETF/warrant ที่หลุด pattern)
    if (!asset.tradable || asset.status !== "active") return false;
    if (isLeveragedName(asset.name)) return false;

    return true;
  });

  return { movers: filtered, assets };
}

const app = new Elysia()
  .get("/movers", async () => {
    try {
      const { movers, assets } = await getFilteredMovers();
      return { message: buildMessage(movers, assets), count: movers.length };
    } catch (err) {
      return { error: String(err) };
    }
  })
  .get("/", async () => "Running!!!")
  .get("/ping", async () => "Pong");

app.listen(7101);

console.log(
  `Movers API is Running🚀`
);
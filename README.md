# VdoHide Service

Internal service (Node.js/TypeScript) ของ [VdoHide](https://vdohide.xyz) — **enqueuer + reaper** ของระบบคิว `video_process` เป็นสมองที่คอยเติมงานให้ Go workers (worker-download, worker-transfer) มา claim ไปทำ

> **ไม่ใช่ web ที่ผู้ใช้เข้าถึง** — รันหลังบ้านตัวเดียวต่อระบบ ไม่ต้องมี nginx/โดเมน

## หน้าที่

**Cron ในตัว (node-schedule):**

| งาน | เวลา | ทำอะไร |
|---|---|---|
| `enqueuer:download` | ทุก 20 วิ | หาไฟล์ `waiting` ที่ยังไม่อยู่ในคิว → เติมเป็นงาน `download` pending ตาม slot ว่างของ worker |
| `enqueuer:transfer` | วินาที 10, 30, 50 | หาไฟล์ที่มี ingest `processed` ค้างบน S3 temp → เติมงาน `transfer` pending พร้อม `targetStorageId` (เลือก storage แบบ balance ตาม % ความจุ) |
| `reaper` | วินาทีที่ 5 ของทุกนาที | ปล่อยงานที่ worker ตายคาไว้ (heartbeat ขาดเกิน 3 นาที) กลับเป็น pending |

**HTTP endpoints** (ไว้ยิง manual/ดูสถานะ — cron รันเองอยู่แล้ว):

- `GET /health` — health check
- `GET /cron-job/download-original` — สั่ง enqueuer download ทันที
- `GET /cron-job/transfer-pending` — สั่ง enqueuer transfer ทันที
- `GET /cron-job/release-stale-jobs` — สั่ง reaper ทันที
- `GET /file/all` — รายการไฟล์

## กติกาสำคัญของคิว

- enqueuer เป็นคน **insert** งาน pending — Go worker เป็นคน claim (atomic `findOneAndUpdate`)
- กันเติมซ้ำด้วย partial unique index `{fileId, processType}` (เฉพาะ status pending/processing) — ยิง enqueuer ซ้ำได้ปลอดภัย (idempotent)
- งาน `failed` / `cancelled` = terminal — **ไม่เติมคิวใหม่เอง** จนกว่า admin จะกด Retry ที่ doc เดิม
- schema `video_process` ต้องตรงกันทุก repo ที่ต่อ DB นี้ (vdohide monorepo, Go workers) — mongoose สร้าง index ตอน start ถ้าฝั่งไหนถือ schema เก่า index เก่าจะถูกสร้างกลับมา block คิว

## Requirements

- **Node.js >= 20** (install.sh ติดตั้ง Node 22 ให้อัตโนมัติถ้าไม่มี)
- **MongoDB** (vdohide platform database)

---

## Installation (Linux Server)

```bash
curl -fsSL https://raw.githubusercontent.com/zergolf1994/vdohide-service/main/install.sh | sudo -E bash -s -- \
    --database-url "mongodb+srv://user:pass@cluster.mongodb.net/platform"
```

| Option | Default | คำอธิบาย |
|---|---|---|
| `--database-url` | `""` | MongoDB connection string (`DATABASE_URL`) |
| `--mongodb-uri` | — | alias ของ `--database-url` |
| `--port` | `4000` | HTTP port (`HTTP_PORT`) |
| `--uninstall` | — | ถอนการติดตั้ง |

ตัว installer จะ: ติดตั้ง Node.js (ถ้าจำเป็น) → โหลด `service.tar.gz` จาก GitHub release ล่าสุด → `npm ci --omit=dev` → สร้าง `.env` + systemd service (`vdohide-service`)

```bash
journalctl -u vdohide-service -f          # ดู logs
systemctl restart vdohide-service         # restart
curl http://localhost:4000/health         # health check
```

## Configuration (.env)

```env
NODE_ENV=production
HTTP_PORT=4000
DATABASE_URL=mongodb+srv://user:pass@cluster.mongodb.net/platform
```

## Settings ใน DB ที่เกี่ยวข้อง (collection `settings`)

| name | ใช้ทำอะไร |
|---|---|
| `download_config` | `{enabled, sort, filter, slotRate}` — เปิด/ปิด + จัดลำดับคิว download |
| `transfer_config` | `{enabled, slotRate}` — เปิด/ปิด + ขนาดคิว transfer |

## Development

```bash
npm install
npm run dev      # ts-node-dev (ต้องมี .env — DATABASE_URL, HTTP_PORT)
npm run build    # tsc + tsc-alias → dist/
npm start        # node dist/server.js
```

## Release

```bash
git tag v0.0.1
git push origin v0.0.1   # → GitHub Actions build + แนบ service.tar.gz กับ release
```

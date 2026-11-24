# Windows 11 Deployment Guide (Target PC)

## 1) Compatibility Check for Your Hardware
Target specs:
- Motherboard: Foxconn H61 (LGA1155)
- CPU: Intel Core i5-3470
- RAM: 16 GB DDR3 (2x8 GB Kingston HyperX 1600)
- Storage: WD 256 GB SATA SSD

### Verdict
- This project itself is compatible with those specs for local use.
- The stack (React/Vite + PHP + MySQL + Python service) is lightweight enough for i5-3470 + 16 GB RAM.
- SSD is sufficient for OS, app, and database.

### Important Windows 11 Note
- Intel i5-3470 is not on Microsoft's officially supported Windows 11 CPU list.
- Many H61 boards also lack TPM 2.0/Secure Boot requirements.
- If Windows 11 is already installed and stable on that PC, this app can still run.

## 2) Required Software on the Target PC
Install these first:
1. XAMPP (Apache + MySQL + phpMyAdmin), PHP 8.x build recommended.
2. Node.js LTS (20+ recommended).
3. Python 3.11+ (3.12 recommended), and enable "Add Python to PATH".
4. Git (optional, only if cloning from repository).

## 3) Copy Project to Target PC
Use one method:
1. Copy the project folder directly (USB/LAN) to:
   `C:\xampp\htdocs\exam-scanner`
2. Or clone with Git into:
   `C:\xampp\htdocs\exam-scanner`

## 4) Backend Setup (PHP + MySQL)
1. Open XAMPP Control Panel.
2. Start `Apache` and `MySQL`.
3. Open `http://localhost/phpmyadmin`.
4. Import database schema:
   - Choose `Import`
   - Select file: `C:\xampp\htdocs\exam-scanner\backend\sql\schema.sql`
   - Run import
5. Check API health:
   `http://localhost/exam-scanner/backend/api/health`

## 5) Frontend Setup (React)
Open PowerShell in `C:\xampp\htdocs\exam-scanner` and run:

```powershell
npm install
```

Create `.env` in project root with:

```env
VITE_API_BASE_URL=http://localhost/exam-scanner/backend/api
```

Start frontend:

```powershell
npm run dev
```

Default URL:
`http://localhost:5173`

## 6) Scanner Service Setup (Python)
Open another PowerShell window in `C:\xampp\htdocs\exam-scanner` and run:

```powershell
python -m pip install pyserial
python scanner-service/main.py
```

Check service status:
`http://127.0.0.1:5001/status`

### Online scanner mode

Use this mode on the Windows PC connected to the Epson and Arduino. The site
must have the PostgreSQL schema scripts installed in order (`postgres.sql`,
`educator-sessions.sql`, then `online-scanner.sql`) and
`EXAM_ONLINE_SCANNER=1` set on its server. For an existing site, apply just
`online-scanner.sql` after the other two scripts are installed.

1. Stop the local Python scanner service before switching modes. Confirm the
   Windows scanner driver, Python packages (`requests`, `pywin32`, `Pillow`,
   `opencv-python`, `pyserial`), and Arduino COM port on this PC.
2. Sign in at [Exam Scanner](https://exam-scanner.onrender.com/), open a subject and its **Scan** tab,
   and select **Pair scanner PC** to get the code for your educator account.
3. From the source folder on the scanner PC, run
   `python scanner-service/main.py --pair-online` and paste the code at the
   prompt. On later starts use `python scanner-service/main.py --online`.
4. Keep the scanner service running. When **Scanner ready** appears, try
   **Single Scan (manual feed)** with one test sheet. Review the result before
   saving. Then test **Start Batch Scan** with the Arduino attached.

Online mode uses an outbound HTTPS connection to receive scan jobs and send
back results. The scanner PC does not need XAMPP for online mode. Use the
original local mode without flags when working with the laptop's MySQL data.
If an upload fails, the scanner service keeps the scan JSON in its `scans`
folder for recovery.

## 7) Verify Full Flow
1. Backend health: `http://localhost/exam-scanner/backend/api/health`
2. Scanner status endpoint: `http://127.0.0.1:5001/status`
3. Frontend opens: `http://localhost:5173`
4. In app, create exam and run scan action.

## 8) Runtime Start Order (Every Reboot)
1. Start XAMPP: Apache + MySQL
2. Start scanner service:
   `python scanner-service/main.py`
3. Build and serve via Apache (recommended for shared access):
   ```powershell
   npm run build
   ```
   Then open: `http://localhost/exam-scanner/dist/`

   *Or* start the dev server (host PC + network devices):
   `npm run dev`

## 9) Accessing from Another Device

Once Apache is running and the frontend is built, any device on the same Wi-Fi or PC hotspot can open the app using the host PC's IP.

| Context | URL |
|---|---|
| Host PC | `http://localhost/exam-scanner/dist/` |
| LAN (use host PC's IP) | `http://<TPC-IP>/exam-scanner/dist/` |
| PC hotspot (typical IP) | `http://192.168.137.1/exam-scanner/dist/` |

**Find your IP:** run `ipconfig` in PowerShell and look for the IPv4 address of your active adapter (Wi-Fi or "Local Area Connection* 12" for the hotspot).

**Firewall:** Windows Defender Firewall must allow inbound TCP on port **80** for Apache. When prompted by Windows during Apache startup, click **Allow**. If not prompted:
1. Open *Windows Defender Firewall with Advanced Security*
2. New Inbound Rule → Port → TCP 80 → Allow

The scanner service stays on `127.0.0.1:5001` (host only). Remote devices reach scanner flows through the PHP backend, which proxies internally.

## 10) Troubleshooting
- `Port 5173 busy`: run `npm run dev -- --port 5174` and update CORS/API config if needed.
- `API DB connection failed`: verify MySQL running and schema imported.
- `CORS errors`: ensure frontend URL matches `cors_origin` in `backend/api/config.php` (or env var).
- `Scanner offline`: confirm Python service is running on port 5001.
- `Remote device can't reach app`: check Windows Firewall allows port 80; verify both devices are on the same network.
- `Remote device gets 404 on assets`: ensure `npm run build` was run after the last code change.

## 11) Optional Production Hardening
- Set backend env vars (`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `SCANNER_SERVICE_URL`, `CORS_ORIGIN`) in Apache/OS environment.

test

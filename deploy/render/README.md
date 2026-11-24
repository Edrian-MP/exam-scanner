# Exam Scanner deployment and scanner integration

The Render service serves the React build and PHP API at
[exam-scanner.onrender.com](https://exam-scanner.onrender.com/).
PHP connects to Supabase PostgreSQL in the `exam_scanner` schema. The local
Windows scanner program can request work from that API over HTTPS after pairing
with an educator account. The PHP backend authorizes the device for its own
active scan session. Approved sheets use the existing submission and gradebook
logic.

## Files to preserve during the physical-machine merge

| Files | Responsibility |
| --- | --- |
| `Dockerfile`, `deploy/render/apache.conf`, `deploy/render/api-router.php`, `deploy/render/start-preview.sh` | Production React build, Apache routing, Authorization header forwarding, database startup and health checks. |
| `backend/sql/postgres.sql`, `backend/sql/educator-sessions.sql`, `backend/api/lib/db.php`, `backend/api/lib/educator_session.php` | PostgreSQL schema and connectivity, educator login, session ownership. |
| `backend/sql/online-scanner.sql`, `backend/api/lib/online_scanner.php` | Scanner pairing, private device authentication, queued jobs, duplicate upload protection and disconnect recovery. |
| `backend/api/index.php`, `backend/api/config.php` | Exam lookup, scan staging and review routes for the online transport. The online mode is selected on the server. |
| `src/App.jsx`, `src/LmsDashboard.jsx` | Pairing controls and polling for scanner status and reviewed sheets. |
| `scanner-service/online_scanner.py` | Outbound job polling, authenticated answer key requests and scan uploads. |
| `scanner-service/main.py`, `scanner-service/omr.py` | Keep the online transport selection and the answer key lookup hook while integrating any newer hardware-specific code. |

Arduino sketches, OMR templates and calibration files, feeder commands, and
scanner timing and image recognition settings were left as provided in the
laptop source. Compare those files against the physical PC before installation.
For `main.py` and `omr.py`, review the diff by section and port the hardware
changes into the integration branch. Preserve its scan start/stop handling,
session IDs, answer key callback, local scan archive and online result upload.
Keep production credentials and database exports outside Git.

## Production configuration

| Setting | Source |
| --- | --- |
| Render service and branch | Use the existing `exam-scanner` web service and its Docker build. Move it to the approved integration branch during rollout. |
| Health check | `/healthz`. On boot the service verifies database access and, when online scanning is enabled, access to the two scanner tables. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS` | Existing Supabase connection settings in Render. Use the restricted app role. |
| `DB_SSLROOTCERT`, `DB_SSLMODE`, `DB_TIMEOUT` | Defaults are the bundled Supabase CA, `verify-full` and 3 seconds. |
| `EXAM_ONLINE_SCANNER` | Set to `1` after applying the scanner schema. |
| `RENDER_EXTERNAL_URL`, `CORS_ORIGIN` | Render supplies the live origin. For an isolated test instance, set `CORS_ORIGIN` to the test site's origin. |
| Vite | Docker builds with `VITE_API_BASE_URL=/exam-scanner/backend/api` and `VITE_EDUCATOR_SESSIONS=1`. |
| Windows scanner API URL | Online mode defaults to the production HTTPS API. `--api-url` can point to another approved HTTPS deployment. |

`SCANNER_SERVICE_URL` and `PHP_API_BASE` are the legacy local endpoints.
Online mode uses the Windows client's outbound connection and does not call
either local endpoint. Use the steps in
[Windows setup](../../README_DEPLOY_WINDOWS11.md#online-scanner-mode)
to pair and start the scanner. The pairing code is a device credential. The
backend stores its hash, and replacing the code revokes the previous code.

## Deploy and verify

1. Obtain approval for live changes. Record the currently live Render deploy ID,
   branch, environment flag and Git commit. Retain a backup of the database and
   the physical system through its existing backup procedures.
2. Confirm the live database already has `postgres.sql` and
   `educator-sessions.sql`. Apply only `backend/sql/online-scanner.sql` to the
   existing database. It adds two private tables and their indexes and grants.
   Verify that the app role has access and the two tables are present.
3. Point the existing Render service to the reviewed integration branch and
   enable `EXAM_ONLINE_SCANNER=1`. Deploy the reviewed commit. Confirm that
   `/healthz` returns HTTP 200, the deployed commit matches, and the website loads.
4. Sign in and verify subject and exam reads, then open a subject and check that **Scan** shows the
   pairing control. Use a designated test educator and disposable data for any
   approved live write verification. The scanner PC is paired during installation.

## Rollback

Use Render's previous successful deployment or deploy the recorded previous
commit. Restore the previous branch and online-scanner setting as applicable.
Leave the additive database tables and any reviewed submissions intact. On the
physical PC, stop the online Python process and restore the backed-up scanner
folder and local startup procedure if needed. The original local workflow uses
the original Windows scanner configuration and local MySQL database.

## Physical machine handoff

1. Back up the installed source, MySQL data and machine configuration. Export
   SQL separately from the source code. Record the active Python interpreter,
   package versions, scanner driver, Arduino COM port and current firmware.
2. Compare the backed-up physical source to the repository branch with a diff
   tool. Integrate newer hardware changes file by file. Recheck the table above
   for files shared by the cloud and hardware implementations.
3. Install the reviewed copy in a separate folder and pair it from an educator
   account. Verify one hand-fed sheet and one batch. Confirm the recognized
   student and exam, score, review and saved gradebook result. Exercise Stop and
   a feeder error on the actual machine.
4. Compare the old database export to the existing website data before any
   import. Use exam and subject ownership to map old teacher records. Review
   and approve the data import separately.

# Deploying ML Agent on an internal network

ML Agent is a folder of static files: HTML, CSS and JavaScript. There is no server-side code, no database, no install, no licence key and no internet access needed. Any internal web server that can serve files can host it.

## What IT needs to know (security summary)

| Topic | Answer |
|---|---|
| Data flow | Users pick a file in their browser. The browser reads it into the tab's memory and does all calculations there. Nothing is uploaded to the web server or anywhere else. |
| Outbound connections | None. The pages carry a Content-Security-Policy with `connect-src 'none'` and `default-src 'none'`, so the browser blocks any request the page might try to make. `web.config` sends the same policy as an HTTP header. |
| Storage | None. No cookies, localStorage, IndexedDB or service workers. Data is wiped on "Finish and delete my data", after 30 idle minutes, and when the page is closed or left. |
| AI or third-party services | None. No LLM, no analytics, no CDN, no web fonts. Every file is served from your server. |
| Dependencies | None. No npm packages or libraries; about 4,000 lines of plain JavaScript you can read. |
| Server requirements | Serve static files over HTTPS. Read-only access is enough. |
| Authentication | Optional. Put the folder behind your normal intranet sign-in (Windows authentication, SSO). The tool itself has no accounts. |
| Integrity | `SHA256SUMS.txt` lists a fingerprint for every file, so you can confirm nothing was changed. |
| Validation status | Decision support and training tool. Not validated for GxP release decisions. |

## Option A: Windows IIS (most common)
1. Copy the folder to the server, for example `C:\inetpub\wwwroot\ml-agent`.
2. In IIS Manager, add it as an application or virtual directory under your intranet site.
3. Keep `web.config`: it adds the security headers.
4. Browse to `https://<intranet>/ml-agent/`.

## Option B: Apache or nginx
Copy the folder under the web root. To send the security headers (recommended), add:

```nginx
location /ml-agent/ {
  add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
}
```

```apache
<Directory "/var/www/html/ml-agent">
  Header always set Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
  Header always set X-Content-Type-Options nosniff
  Header always set Referrer-Policy no-referrer
</Directory>
```

## Option C: no server at all
Put the folder on a shared drive. Users open `index.html` directly in Edge or Chrome. Everything works, including offline. This is the quickest pilot, but a web server gives a cleaner link and central updates.

## About SharePoint
SharePoint Online usually downloads `.html` files instead of showing them, and blocks custom scripts. It is not a good host. Use IIS, an internal static web host (for example Azure Static Web Apps or an App Service with company sign-in, or GitHub Enterprise Pages), or Option C.

## Check the files were not changed
Linux or macOS, inside the folder:
```sh
sha256sum -c SHA256SUMS.txt
```
Windows PowerShell, inside the folder:
```powershell
Get-Content SHA256SUMS.txt | ForEach-Object { $h, $f = $_ -split '\s+', 2; if ((Get-FileHash $f -Algorithm SHA256).Hash -ne $h.ToUpper()) { "CHANGED: $f" } }
```
No output from the PowerShell command means every file matches.

## Smoke test after deployment (5 minutes)
1. Open the page. The green "Private" badge shows in the header.
2. Press **Run privacy self-test**. It must say "Passed".
3. Load the practice dataset **Injection molding yield** and run. Expect Quadratic, about 89% explained.
4. Open developer tools (F12) → Network, run again, and confirm that only the tool's own files appear.
5. Open **Learn the concepts** and click through a lesson.
6. Press **Finish and delete my data**.

## Updating
Replace the folder with a new package. Users get the new version on their next page load.

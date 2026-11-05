# Setup (phone se ho jayega)

1. GitHub par naya **public** repo banao, ye saari files upload karo (branch: main).
2. Cloudflare: API Token banao (permissions: Workers Scripts Edit, R2 Edit). Account ID copy karo.
3. GitHub token (PAT, fine-grained): sirf is repo par, **Actions: Read and write**.
4. Repo -> Settings -> Secrets -> Actions mein ye 6 secrets daalo:
   - CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
   - GH_PAT (upar wala token)
   - APP_PASSWORD (tum dono ka password)
   - CALLBACK_SECRET (koi lamba random text)
   - WORKER_URL (pehli deploy ke baad, https://apk-runner.<tumhara-subdomain>.workers.dev)
5. Actions tab -> "deploy-cloudflare" -> Run workflow. Worker URL milne ke baad WORKER_URL secret daalo.
6. Worker URL kholo -> password + APK -> Upload & Run -> 3-5 min baad screen dikhegi.
7. Session ~5.5 ghante ka hai; khatam hone se 8 min pehle wahi APK apne aap naye session mein phir chalu ho jati hai. Rokne ke liye "Stop auto-restart" dabao.

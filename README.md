# X Comment Agent 🐋

An AI-powered system that automatically comments on X (Twitter) posts in your voice. Runs 24/7 on a cloud server. Controlled from your phone via Telegram.

## What It Does

- Monitors your private X lists for new tweets around the clock
- Generates comments in YOUR voice using Claude AI
- Posts automatically (autonomous mode) or sends you options to approve (manual mode)
- Learns from your feedback and gets better over time
- You control everything from Telegram on your phone

## Two Modes

**Autonomous Agent** — comments without your approval. You get notifications with Good/Feedback/Delete buttons. Best for big accounts where speed matters.

**Manual Agent** — sends you 5 comment options per tweet. You tap one button to approve. Best for relationship-building lists where quality matters more than speed.

## Monthly Cost

| Service | Cost | What it does |
|---------|------|-------------|
| Hetzner server | ~$8/mo | Computer that runs 24/7 |
| Claude API (Anthropic) | ~$20/mo | Generates comments |
| Telegram | Free | Notifications and control |
| **Total** | **~$30/mo** | |

---

# Setup Guide

This guide walks you through every single step. If you've never set up a server before, that's fine. Follow each step exactly.

---

## Step 1: Create a Hetzner Account

Hetzner is a cloud hosting company. You're renting a computer from them that runs 24/7.

1. Go to **hetzner.com**
2. Click **Sign Up** in the top right
3. Enter your email and create a password
4. You'll need to add a payment method (credit card or PayPal). Hetzner may ask for ID verification — this is normal, follow their steps.
5. Once verified, go to **console.hetzner.cloud** — this is your dashboard

---

## Step 2: Generate an SSH Key on Your Computer

An SSH key is like a digital password that lets you securely connect to your server. It comes in two parts: a private key (stays on your computer, never share it) and a public key (you give to Hetzner).

### On Mac

1. Open **Terminal** (press **Cmd + Space**, type **Terminal**, hit Enter)
2. Paste this command and hit Enter:

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
```

3. It asks "Enter file in which to save the key" — just press **Enter** (accept the default)
4. It asks for a passphrase — press **Enter** twice (no passphrase, keeps it simple)
5. Now copy your public key:

```bash
cat ~/.ssh/id_ed25519.pub
```

6. This prints a line starting with `ssh-ed25519` followed by random characters. **Copy that entire line.**

### On Windows

1. Open **PowerShell** (search for it in Start menu)
2. Run the same commands as Mac above

---

## Step 3: Create the Server

1. In the Hetzner dashboard (console.hetzner.cloud), click **Servers** in the left sidebar
2. Click the red **"+ Create Server"** button
3. Choose these settings:

**Location:** Pick any European location. Nuremberg or Falkenstein are good choices.

**Image (Operating System):** Select **Ubuntu 24.04**

**Type:** Click the **"x86 (Intel/AMD)"** tab. Under "Shared vCPU", find and select **CPX22** (2 vCPUs, 4 GB RAM). It costs about $7.59/month. If you see a cheaper CX22 under "Cost-Optimized", that works too.

**Networking:** Leave the defaults (Public IPv4 should be checked)

**SSH Keys:** Click **"Add SSH Key"**. Paste the public key you copied in Step 2. Name it something like "My Mac" or "My PC". Click Add.

**Volumes, Firewalls, Backups:** Skip all of these. Don't touch them.

**Name:** Change it to something like **x-agent**

4. Click the red **"Create & Buy now"** button at the bottom right
5. Wait 30 seconds. Your server will appear with an **IP address** (a number like `123.45.67.89`). Write this down — you'll need it for everything.

---

## Step 4: Connect to Your Server

Open Terminal (Mac) or PowerShell (Windows) and run:

```bash
ssh root@YOUR_SERVER_IP
```

Replace `YOUR_SERVER_IP` with the actual IP from Step 3 (e.g., `ssh root@123.45.67.89`).

It will ask: "Are you sure you want to continue connecting?" Type **yes** and hit Enter.

You should see a welcome message and a prompt that looks like:

```
root@x-agent:~#
```

**This means you're inside your server.** Every command from here runs on the server, not your computer.

**Important:** Your computer terminal might show `yourname@your-computer` or `root@x-agent`. Make sure you're running commands on the right one:
- `root@x-agent:~#` = you're on the **server** (good, run server commands here)
- `yourname@your-computer` = you're on your **own computer** (use this for uploading files)

---

## Step 5: Install Node.js and Playwright on the Server

Run these commands one by one on the server (where you see `root@x-agent:~#`):

```bash
# Update the system
apt update && apt upgrade -y
```

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

```bash
# Verify Node.js installed
node --version
# Should show v22.x.x
```

```bash
# Create project folder and go into it
mkdir -p /root/x-comment-agent
cd /root/x-comment-agent
```

```bash
# Initialize the project
npm init -y
```

```bash
# Install Playwright (this downloads a headless Chrome browser)
npm install playwright
npx playwright install chromium
npx playwright install-deps
```

The last command installs Chrome's dependencies and takes 1-2 minutes. Wait for it to finish.

---

## Step 6: Upload the Agent Code

Open a **new terminal tab on your computer** (not the server). On Mac press **Cmd + T** for a new tab.


Now upload the files to your server. Replace `YOUR_SERVER_IP` with your actual IP:

```bash
scp whale-bot.js root@YOUR_SERVER_IP:/root/x-running-agent/
scp manual-bot.js root@YOUR_SERVER_IP:/root/x-running-agent/
scp -r scripts/ root@YOUR_SERVER_IP:/root/x-running-agent/
scp -r prompts/ root@YOUR_SERVER_IP:/root/x-running-agent/
scp -r services/ root@YOUR_SERVER_IP:/root/x-running-agent/
scp config.example.json root@YOUR_SERVER_IP:/root/x-running-agent/config.json
scp .env.example root@YOUR_SERVER_IP:/root/x-running-agent/.env
```

Each command should show a progress bar and say "100%". If you get "Permission denied", make sure you're using `root@` before your IP.

---

## Step 7: Export Your X Cookies

The server needs to be "logged in" to your X account. We do this by copying your login cookies from your browser.

1. Open **Chrome** on your computer
2. Go to the Chrome Web Store and install **"EditThisCookie"** extension
3. Go to **x.com** and make sure you're logged in to your account
4. Click the **EditThisCookie icon** in your Chrome toolbar (looks like a cookie)
5. Click the **Export button** (the icon that looks like a clipboard/copy). This copies all your X cookies.
6. Open any text editor (TextEdit on Mac, Notepad on Windows)
7. Paste (Cmd+V or Ctrl+V) and save the file as **cookies-raw.json**
8. Upload it to your server (from your computer terminal, not the server):

```bash
scp ~/Downloads/cookies-raw.json root@YOUR_SERVER_IP:/root/x-comment-agent/
```

If you saved it somewhere else, change the path. For example if it's on your Desktop:
```bash
scp ~/Desktop/cookies-raw.json root@YOUR_SERVER_IP:/root/x-comment-agent/
```

9. Now go to your **server terminal** (where you see `root@x-agent:~#`) and convert the cookies:

```bash
cd /root/x-comment-agent
node scripts/setup-cookies.js
```

You should see: **✅ Converted XX cookies**

### Test the Login

Still on the server, run this to verify the cookies work:

```bash
cd /root/x-comment-agent && node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({headless:true, args:['--no-sandbox']});
  const c = await b.newContext({storageState:'./x-session.json', viewport:{width:1280,height:720}});
  const p = await c.newPage();
  await p.goto('https://x.com/home', {waitUntil:'domcontentloaded', timeout:60000});
  await p.waitForTimeout(3000);
  const url = await p.url();
  console.log(url.includes('/login') ? 'FAILED - try exporting cookies again' : 'SUCCESS - logged in!');
  await b.close();
})();
"
```

If it says **SUCCESS**, you're good. If it says **FAILED**, go back and re-export your cookies making sure you're logged into X.

**Important:** Cookies expire every few weeks. When the bot stops working and says "X session expired", just re-export cookies from your browser and re-run the setup script.

---

## Step 8: Get Your API Keys

### Anthropic API Key (for Claude AI to generate comments)

1. Go to **console.anthropic.com**
2. Create an account
3. Add a payment method (pay-as-you-go, you'll spend about $20/month)
4. Go to **API Keys** in the sidebar
5. Click **Create Key**
6. Copy the key — it starts with `sk-ant-...`

### Create a Telegram Bot

This is how you'll control the agent from your phone.

1. Open **Telegram** on your phone
2. Search for **@BotFather** (it's a verified bot from Telegram)
3. Tap **Start**
4. Send the message: `/newbot`
5. BotFather asks for a name — type something like **X Comment Agent**
6. BotFather asks for a username — type something like `yourname_xagent_bot` (must end in `bot`)
7. BotFather replies with your **bot token** — a long string like `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ`. **Copy this.**
8. Now go to your new bot (search for it by the username you just created) and tap **Start**. This is required before the bot can send you messages.

### Get Your Telegram Chat ID

1. Search for **@userinfobot** on Telegram
2. Send it any message (like "hi")
3. It replies with your **ID** number (like `2072951064`). Copy this.

### Save Everything on the Server

Go to your server terminal and edit the env file:

```bash
cd /root/x-comment-agent
nano .env
```

You'll see placeholder text. Replace each line with your real values:

```
TELEGRAM_BOT_TOKEN=paste_your_bot_token_here
TELEGRAM_CHAT_ID=paste_your_chat_id_here
ANTHROPIC_API_KEY=paste_your_anthropic_key_here
X_USERNAME=your_x_username_without_the_at_sign
```

To save in nano: press **Ctrl + X**, then **Y**, then **Enter**.

---

## Step 9: Create Your X Lists

Go to X (twitter.com or the app):

1. Click **Lists** in the sidebar (or go to x.com/lists)
2. Click **Create a new list**
3. Name it something like **"Whales - Tier 1"**
4. Make it **Private** (toggle the lock icon)
5. Add accounts to the list — these are the people you want to comment on. Start with 10-20 active accounts.
6. Copy the list URL from your browser. It looks like: `https://x.com/i/lists/1234567890`

### How to organize your lists

Create separate lists for different goals:

| List | Purpose | Who to add |
|------|---------|-----------|
| Whales | Impressions & followers | Big accounts with 100k+ followers |
| Peer Builders | Relationships & collabs | Builders at your level (10k-50k) |
| Potential Clients | Inbound leads | People who might hire you |
| Content Crossover | Newsletter subscribers | Writers, content creators |
| Rising Stars | Early relationships | Small but growing accounts (1k-10k) |
| Opportunity | Speaking, events | Space hosts, event organizers, podcast hosts |

### Update Your Config

On the server:

```bash
nano /root/x-comment-agent/config.json
```

Replace the placeholder list URLs and strategies. Each list needs a name, URL, and strategy (instructions for how to comment on that list).

---

## Step 10: Write Your Voice Prompt

This is the most important file. It tells Claude how to sound like YOU. Bad prompt = generic AI comments. Good prompt = comments that sound genuinely human.

```bash
cd /root/x-comment-agent
cp prompts/whale-prompt.example.txt prompts/whale-prompt.txt
nano prompts/whale-prompt.txt
```

Edit the file and customize everything:

- **Replace the example comments** with comments YOU would actually write
- **Add words you never use** (e.g., "leverage", "synergy", "unlock")
- **Describe your writing style** — short sentences? casual? lowercase? question marks?
- **Add 5-10 examples** of good comments you'd write
- **Add 5-10 examples** of bad comments you'd never write

Spend at least 30 minutes on this. The better your prompt, the better every single comment will be.

---

## Step 11: Test Run

Make sure you've tapped **Start** on your Telegram bot (Step 8).

On the server:

```bash
cd /root/x-comment-agent
source .env && export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ANTHROPIC_API_KEY X_USERNAME
node whale-bot.js
```

You should see:

```
🐋 Whale Auto-Commenter starting...
Verifying login...
Logged in!
Found X tweets
```

And a message on Telegram saying the bot is online. If someone on your list tweeted recently, you'll see the bot generate and post a comment within a minute or two.

Press **Ctrl + C** to stop it when you're done testing.

---

## Step 12: Run It 24/7

Now we make it run forever, even when you close your laptop.

```bash
# Copy the service file
cp /root/x-comment-agent/services/whale-bot.service /etc/systemd/system/

# Open it and make sure the paths are correct
nano /etc/systemd/system/whale-bot.service
```

Make sure `WorkingDirectory` says `/root/x-comment-agent` and `ExecStart` says `/usr/bin/node /root/x-comment-agent/whale-bot.js`. Save and exit.

```bash
# Tell the system about the new service
systemctl daemon-reload

# Enable it to start on boot
systemctl enable whale-bot

# Start it now
systemctl start whale-bot

# Check it's running
systemctl status whale-bot
```

You should see **active (running)** in green. The bot is now running 24/7. It auto-restarts if it crashes.

### Managing the Bot from the Server

```bash
systemctl status whale-bot       # Is it running?
systemctl stop whale-bot         # Stop it
systemctl start whale-bot        # Start it
systemctl restart whale-bot      # Restart it
journalctl -u whale-bot -f       # Watch live logs (Ctrl+C to exit)
```

---

## Controlling from Telegram

Once running, you control everything from your phone:

| Command | What it does |
|---------|-------------|
| `/wstart` | Resume auto-commenting |
| `/wstop` | Pause everything instantly |
| `/wstats` | Show today's stats |
| `/wfeedback` | Show feedback statistics |
| `/whelp` | Show all commands |

Every comment notification has three buttons:
- **✅ Good** — you like the comment, no action needed
- **💬 Feedback** — type feedback to improve future comments (comment stays posted)
- **🗑 Delete** — removes the comment from X and asks for your feedback

---

## Safety Features

| Feature | Default | What it does |
|---------|---------|-------------|
| Max per hour | 20 | Won't post more than 20 comments/hour |
| Max per day | 100 | Won't post more than 100 comments/day |
| Minimum gap | 3 min | Waits at least 3 min between comments |
| Burst protection | 5 in 30 min | Forces 15 min cooldown after a burst |
| Author cooldown | 4 hours | Won't comment on same person twice in 4 hours |
| Random skip | 20% | Randomly skips 20% of tweets |
| Human delay | 30-90 sec | Waits before posting to look natural |
| Tweet age limit | 30 min | Only comments on recent tweets |
| Kill switch | `/wstop` | Instantly stops from Telegram |

All these values are at the top of `whale-bot.js`. Change them to whatever you want.

---

## Troubleshooting

**"X session expired" or bot stops posting**
Your cookies expired. This happens every few weeks.
1. Go to x.com on your browser, make sure you're logged in
2. Export cookies with EditThisCookie
3. Upload: `scp cookies-raw.json root@YOUR_IP:/root/x-comment-agent/`
4. Convert: `ssh root@YOUR_IP "cd /root/x-comment-agent && node scripts/setup-cookies.js"`
5. Restart: `ssh root@YOUR_IP "systemctl restart whale-bot"`

**"Found 0 tweets" every cycle**
- Your list might be empty — add more accounts
- All tweets might be older than 30 min — wait for someone to tweet
- Your cookies might have expired (see above)

**Comments sound generic or robotic**
- Improve your voice prompt in `prompts/whale-prompt.txt`
- Add more examples of good and bad comments
- Use the feedback buttons — every piece of feedback improves future comments

**Bot keeps crashing**
- Check logs: `journalctl -u whale-bot --no-pager | tail -50`
- Usually a memory issue — restart: `systemctl restart whale-bot`
- If it keeps happening, your server might need a reboot: `reboot`

**Can't connect to server (SSH)**
- Make sure you're using the right IP
- Make sure your SSH key is set up (Step 2)
- Try: `ssh -v root@YOUR_IP` for debug info

---

## Architecture

```
Your X Lists (private)
    │
    ▼
Cloud Server ($8/mo, runs 24/7)
    │
    ├── Headless Chrome (logged into X via cookies)
    │       ├── Scrapes list every 60 seconds
    │       ├── Finds new tweets (< 30 min old)
    │       └── Posts comments automatically
    │
    ├── Claude AI (Anthropic API)
    │       ├── Reads your custom voice prompt
    │       ├── Reads your past feedback
    │       └── Generates comment in your voice
    │
    └── Telegram Bot
            ├── Sends you notifications
            ├── Good / Feedback / Delete buttons
            ├── Commands: /wstats /wstop /wstart
            └── Feedback → improves future comments
```

---

## License

MIT — do whatever you want with it.

## Credits

Built by [@talhaasiiif](https://x.com/talhaasiiif).

Need help setting this up? DM me on [X](https://x.com/talhaasiiif).

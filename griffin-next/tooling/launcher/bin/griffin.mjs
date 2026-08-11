#!/usr/bin/env node
if (process.env.__GRIFFIN_LAUNCHER_PID) {
  process.stderr.write(
    `griffin: launcher invoked recursively (parent pid ${process.env.__GRIFFIN_LAUNCHER_PID}). Exiting.\n`,
  )
  process.exit(2)
}
process.env.__GRIFFIN_LAUNCHER_PID = String(process.pid)

import { execFileSync, execSync, spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const SELF_PATH = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return ""
  }
})()

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"
const CLEAR_LINE = "\x1b[2K\r"

const LOGO = [
  "  ██████╗ ██████╗ ██╗███████╗███████╗██╗███╗   ██╗",
  " ██╔════╝ ██╔══██╗██║██╔════╝██╔════╝██║████╗  ██║",
  " ██║  ███╗██████╔╝██║█████╗  █████╗  ██║██╔██╗ ██║",
  " ██║   ██║██╔══██╗██║██╔══╝  ██╔══╝  ██║██║╚██╗██║",
  " ╚██████╔╝██║  ██║██║██║     ██║     ██║██║ ╚████║",
  "  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝     ╚═╝     ╚═╝╚═╝  ╚═══╝",
]

function ok(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`)
}
function warn(msg) {
  console.log(`  ${YELLOW}⚠${RESET} ${msg}`)
}

function spinner(msg) {
  const frames = ["◒", "◐", "◓", "◑"]
  let i = 0
  process.stdout.write(HIDE_CURSOR)
  const id = setInterval(() => {
    process.stdout.write(`${CLEAR_LINE}  ${CYAN}${frames[i++ % frames.length]}${RESET} ${msg}`)
  }, 80)
  return {
    ok(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      ok(result)
    },
    warn(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      warn(result)
    },
    fail(result) {
      clearInterval(id)
      process.stdout.write(`${CLEAR_LINE}${SHOW_CURSOR}`)
      console.log(`  ${RED}✗${RESET} ${result}`)
    },
    update(m) {
      msg = m
    },
  }
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

// Windows global installs expose a .cmd shim, which can't be exec'd
// directly — it needs a shell (and the path quoted for it).
const isCmdShim = (p) => process.platform === "win32" && p.toLowerCase().endsWith(".cmd")

function execCli(file, args = [], opts = {}) {
  if (isCmdShim(file)) return execSync(['"' + file + '"', ...args].join(" "), opts)
  return execFileSync(file, args, opts)
}

function runFileQuiet(file, args = []) {
  try {
    return execCli(file, args, { encoding: "utf-8", stdio: "pipe" }).trim()
  } catch {
    return null
  }
}

function isLauncherPath(p) {
  try {
    const real = realpathSync(p)
    if (SELF_PATH && real === SELF_PATH) return true
    if (real.includes("/_npx/")) return true
    return false
  } catch {
    return false
  }
}

// Returns the absolute path to the real @synsci/griffin binary (`griffin`).
// Only trusts canonical install locations (no `$PATH` walk) to avoid picking
// up dev shims or workspace symlinks. Each candidate is verified by invoking
// `--version` so half-broken installs are skipped instead of accepted.
function resolveCli() {
  const candidates = []
  // 1. Global npm prefix (where `npm i -g @synsci/griffin` puts it).
  // On Windows the global bin dir is the prefix itself and the entry is an
  // griffin.cmd shim; on POSIX it's <prefix>/bin/griffin.
  const prefix = runQuiet("npm prefix -g")
  if (prefix) {
    if (process.platform === "win32") candidates.push(join(prefix, "griffin.cmd"))
    else candidates.push(join(prefix, "bin", "griffin"))
  }
  // 2. ~/.griffin/bin/griffin (curl-installer location, POSIX only)
  if (process.platform !== "win32") candidates.push(join(homedir(), ".griffin", "bin", "griffin"))

  for (const cand of candidates) {
    if (!existsSync(cand) || isLauncherPath(cand)) continue
    try {
      const ver = execCli(cand, ["--version"], {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 5000,
      }).trim()
      if (/^\d/.test(ver)) return cand
    } catch {
      /* unrunnable candidate, try next */
    }
  }
  return null
}

// The deprecated `@synsci/cli` package links the same `griffin` bin. npm
// refuses to overwrite a bin file owned by another package (EEXIST), so a
// stale global install dead-ends the upgrade — and its old binary shadows the
// real one on PATH. `npm ls` exits nonzero when the package is absent but
// still prints JSON, so read stdout either way.
function hasDeprecatedCli() {
  let out = ""
  try {
    out = execSync("npm ls -g @synsci/cli --depth=0 --json", { encoding: "utf-8", stdio: "pipe" })
  } catch (e) {
    out = e && typeof e.stdout === "string" ? e.stdout : ""
  }
  try {
    return Boolean(JSON.parse(out).dependencies["@synsci/cli"])
  } catch {
    return false
  }
}

function isConnected() {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const sessionPath = join(xdgData, "griffin", "griffin-session.json")
  if (!existsSync(sessionPath)) return false
  try {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"))
    if (!data.access_token || !data.expires_at) return false
    return new Date(data.expires_at) > new Date()
  } catch {
    return false
  }
}

function atlasVersion() {
  // `atlas` on PATH may be Ariga Atlas or the MongoDB Atlas CLI, whose
  // --version output also survives the digit filter. Only trust the command
  // when the global @synsci/atlas package is present to own it.
  const owned = runQuiet("npm ls -g @synsci/atlas --depth=0")
  if (!owned || !owned.includes("@synsci/atlas")) return null
  const raw = runQuiet("atlas --version")
  return raw ? raw.replace(/[^0-9.]/g, "") : null
}

// Install the Atlas CLI, or bring an existing install up to date. Returns
// true when a working `atlas` binary is on PATH afterwards.
async function installOrUpdateAtlas() {
  const current = atlasVersion()
  if (current) {
    const s = spinner("Checking Atlas CLI for updates...")
    const latest = runQuiet("npm view @synsci/atlas version")
    if (!latest || current === latest) {
      s.ok(`atlas ${current} ${DIM}(up to date)${RESET}`)
      return true
    }
    s.update(`Upgrading Atlas CLI ${current} → ${latest}...`)
    if (runQuiet("npm i -g @synsci/atlas@latest") !== null) {
      s.ok(`Upgraded Atlas CLI to ${latest}`)
    } else {
      s.warn(`Atlas CLI upgrade failed, continuing with ${current}`)
    }
    return true
  }
  const s = spinner("Installing Atlas CLI...")
  if (runQuiet("npm i -g @synsci/atlas@latest") !== null && atlasVersion()) {
    s.ok("Installed Atlas CLI")
    return true
  }
  s.warn(`Atlas CLI install failed, you can retry later: ${CYAN}npm i -g @synsci/atlas${RESET}`)
  return false
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  process.on("exit", () => process.stdout.write(SHOW_CURSOR))
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR)
    process.exit(130)
  })

  // --- Logo ---
  console.log()
  for (const line of LOGO) console.log(`   ${CYAN}${line}${RESET}`)
  console.log()
  console.log(
    `   ${BOLD}Synthetic Sciences${RESET} ${DIM}Griffin, the open-source AI research workspace · Atlas, the research platform${RESET}`,
  )
  console.log()

  // --- Step 1: Install or upgrade the Griffin CLI ---
  if (hasDeprecatedCli()) {
    const s = spinner("Removing the deprecated @synsci/cli so it can't shadow the griffin command...")
    if (runQuiet("npm rm -g @synsci/cli") !== null) {
      s.ok("Removed the deprecated @synsci/cli")
    } else {
      s.warn(`Couldn't remove the deprecated @synsci/cli — if install fails, run: ${CYAN}npm rm -g @synsci/cli${RESET}`)
    }
  }

  let cliPath = resolveCli()
  if (cliPath) {
    const raw = runFileQuiet(cliPath, ["--version"]) || "unknown"
    const isDev = raw === "local" || raw.includes("-")
    if (isDev) {
      ok(`griffin ${DIM}(dev build)${RESET}`)
    } else {
      const s = spinner("Checking for updates...")
      const current = raw.replace(/[^0-9.]/g, "")
      const latest = runQuiet("npm view @synsci/griffin version")
      if (!latest || current === latest) {
        s.ok(`griffin ${current} ${DIM}(up to date)${RESET}`)
      } else {
        s.update(`Upgrading ${current} → ${latest}...`)
        try {
          execCli(cliPath, ["upgrade"], { stdio: "pipe" })
          s.ok(`Upgraded to ${latest}`)
        } catch {
          s.warn(`Upgrade failed, continuing with ${current}`)
        }
      }
    }
  } else {
    const s = spinner("Installing Griffin...")
    try {
      try {
        execSync("npm i -g @synsci/griffin@latest", { stdio: "pipe" })
      } catch (e) {
        // npm refuses to overwrite a bin file owned by another package
        // (EEXIST). If the conflict is the deprecated @synsci/cli, remove it
        // and retry once before falling back to the standalone installer.
        const stderr = e && e.stderr ? String(e.stderr) : ""
        const conflict = stderr.includes("EEXIST") && (stderr.includes("@synsci/cli") || hasDeprecatedCli())
        if (!conflict) throw e
        s.update("Removing the deprecated @synsci/cli so it can't shadow the griffin command...")
        runQuiet("npm rm -g @synsci/cli")
        s.update("Retrying the Griffin install...")
        execSync("npm i -g @synsci/griffin@latest", { stdio: "pipe" })
      }
      cliPath = resolveCli()
      if (!cliPath) throw new Error("griffin not on PATH after install")
      s.ok("Installed Griffin")
    } catch {
      // The standalone installer is a bash script; on native Windows there's
      // no bash to pipe it into, so don't suggest a fallback that can't run.
      if (process.platform === "win32") {
        s.fail("Install failed")
        console.log(`\n  Try manually: ${CYAN}npm i -g @synsci/griffin${RESET}\n`)
        process.exit(1)
      }
      // Global npm installs commonly fail on permissions. Fall back to the
      // standalone installer, which lands in ~/.griffin/bin without sudo
      // (resolveCli already checks that location).
      s.update("npm -g failed, trying the standalone installer...")
      try {
        execSync("curl -fsSL https://griffin.sh/install | bash", { stdio: "pipe" })
        cliPath = resolveCli()
        if (!cliPath) throw new Error("griffin not found after install")
        s.ok("Installed Griffin")
      } catch (e2) {
        s.fail(`Install failed${e2 && e2.message ? ": " + e2.message : ""}`)
        console.log(`\n  Try manually: ${CYAN}npm i -g @synsci/griffin${RESET}`)
        console.log(`  or:           ${CYAN}curl -fsSL https://griffin.sh/install | bash${RESET}\n`)
        process.exit(1)
      }
    }
  }

  // --- Step 2: Choose a setup ---
  console.log()
  console.log(`  ${BOLD}How do you want to run it?${RESET}`)
  console.log()
  console.log(
    `    ${BOLD}1${RESET}  ${CYAN}Griffin${RESET}         ${DIM}free and open source, bring your own API keys, no account${RESET}`,
  )
  console.log(
    `    ${BOLD}2${RESET}  ${CYAN}Griffin + Atlas${RESET} ${DIM}managed models, wallet billing, research graph & compute${RESET}`,
  )
  console.log(
    `    ${BOLD}3${RESET}  ${CYAN}Atlas CLI${RESET}           ${DIM}just the Atlas research CLI — maps, runs, and compute from the terminal${RESET}`,
  )
  console.log()

  const setup = await ask(`  ${DIM}❯${RESET} Choose [1/2/3]: `)
  console.log()

  if (setup === "3") {
    // Atlas-CLI-only path: install/upgrade, verify, hand off to `atlas`.
    // No workspace launch — this option exists for people who want the
    // research CLI on a box without opening the browser app.
    const installed = await installOrUpdateAtlas()
    if (!installed) process.exit(1)
    const s = spinner("Running atlas doctor...")
    if (runQuiet("atlas doctor") !== null) {
      s.ok("atlas doctor passed")
    } else {
      s.warn(`atlas doctor reported issues — run ${CYAN}atlas doctor${RESET} for details`)
    }
    if (isConnected()) {
      ok("Connected to Atlas")
    } else {
      console.log()
      console.log(
        `  ${DIM}Connect your Atlas account for managed credentials:${RESET} ${CYAN}griffin connect login${RESET}`,
      )
    }
    console.log()
    console.log(`  ${BOLD}Next steps${RESET}`)
    console.log(`    ${CYAN}atlas --help${RESET}   ${DIM}see everything the CLI can do${RESET}`)
    console.log(`    ${CYAN}atlas doctor${RESET}   ${DIM}check credentials and environment${RESET}`)
    console.log()
    process.exit(0)
  }

  if (setup === "2") {
    await installOrUpdateAtlas()
    if (isConnected()) {
      ok("Connected to Atlas")
    } else {
      console.log()
      try {
        execCli(cliPath, ["connect", "login"], { stdio: "inherit" })
      } catch {}
    }
  } else {
    ok(`BYOK mode ${DIM}add provider keys inside the app (or via env vars like ANTHROPIC_API_KEY)${RESET}`)
  }

  console.log()

  // --- Step 3: Launch the workspace ---
  console.log(`  ${DIM}Opening the workspace in your browser…${RESET}`)
  console.log()

  const webArgs = ["web", ...process.argv.slice(2)]
  const child = isCmdShim(cliPath)
    ? spawn(['"' + cliPath + '"', ...webArgs].join(" "), { stdio: "inherit", shell: true })
    : spawn(cliPath, webArgs, { stdio: "inherit" })
  child.on("close", (code) => process.exit(code ?? 0))
}

main().catch((err) => {
  process.stdout.write(SHOW_CURSOR)
  console.error(err)
  process.exit(1)
})

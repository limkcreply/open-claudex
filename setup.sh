#!/usr/bin/env bash
# setup.sh — patches your Claude Code source tree for local LLM support
# Usage: ./setup.sh /path/to/your/claude-code

set -e

CLAUDE_DIR="${1:-.}"

if [ ! -f "$CLAUDE_DIR/services/api/client.ts" ]; then
  echo "Error: not a Claude Code source directory: $CLAUDE_DIR"
  echo "Usage: ./setup.sh /path/to/claude-code"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Patching Claude Code at: $CLAUDE_DIR"

# 1. Copy the adapter
cp "$SCRIPT_DIR/src/localLlmAdapter.ts" "$CLAUDE_DIR/services/api/"
echo "  [+] copied localLlmAdapter.ts"

# 1b. Replace logo and welcome screen
cp "$SCRIPT_DIR/src/Clawdex.tsx" "$CLAUDE_DIR/components/LogoV2/Clawdex.tsx"
cp "$SCRIPT_DIR/src/WelcomeV2.tsx" "$CLAUDE_DIR/components/LogoV2/WelcomeV2.tsx"
# Update imports to point to Clawdex
for f in "$CLAUDE_DIR/components/LogoV2/LogoV2.tsx" \
         "$CLAUDE_DIR/components/LogoV2/CondensedLogo.tsx" \
         "$CLAUDE_DIR/components/LogoV2/AnimatedClawd.tsx"; do
  if [ -f "$f" ]; then
    sed -i '' "s|from './Clawd.js'|from './Clawdex.js'|g" "$f"
  fi
done
echo "  [+] replaced logo and welcome screen"

# 2. Add local provider to providers.ts
PROVIDERS="$CLAUDE_DIR/utils/model/providers.ts"
if ! grep -q "isLocalProvider" "$PROVIDERS" 2>/dev/null; then
  # Add 'local' to APIProvider type
  sed -i '' "s/export type APIProvider = 'firstParty'/export type APIProvider = 'firstParty' | 'local'/" "$PROVIDERS"
  # Add local check at top of getAPIProvider
  sed -i '' "/export function getAPIProvider/,/return/ {
    /return/i\\
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_LOCAL)) return 'local'
  }" "$PROVIDERS" 2>/dev/null || true
  # Add isLocalProvider helper
  echo "
export function isLocalProvider(): boolean {
  return getAPIProvider() === 'local'
}" >> "$PROVIDERS"
  echo "  [+] patched providers.ts"
else
  echo "  [~] providers.ts already patched"
fi

# 3. Wire adapter in client.ts
CLIENT="$CLAUDE_DIR/services/api/client.ts"
if ! grep -q "localLlmAdapter" "$CLIENT" 2>/dev/null; then
  # Add import at top (after last import)
  sed -i '' "1,/^import/ {
    /^import.*providers/ a\\
import { createLocalLlmFetch } from './localLlmAdapter.js'
  }" "$CLIENT" 2>/dev/null || true
  echo "  [+] patched client.ts (import added — wire the adapter manually in the client function)"
else
  echo "  [~] client.ts already patched"
fi

# 4. Disable analytics for local mode
ANALYTICS="$CLAUDE_DIR/services/analytics/config.ts"
if ! grep -q "CLAUDE_CODE_USE_LOCAL" "$ANALYTICS" 2>/dev/null; then
  sed -i '' "/export function isAnalyticsDisabled/,/return/ {
    /return/i\\
  if (process.env.CLAUDE_CODE_USE_LOCAL) return true
  }" "$ANALYTICS" 2>/dev/null || true
  echo "  [+] patched analytics config"
else
  echo "  [~] analytics already patched"
fi

# 5. Skip metrics check for local
METRICS="$CLAUDE_DIR/services/api/metricsOptOut.ts"
if ! grep -q "CLAUDE_CODE_USE_LOCAL" "$METRICS" 2>/dev/null; then
  sed -i '' "/export.*function.*checkMetricsEnabled\|export.*async.*function.*checkMetricsEnabled/,/^}/ {
    /^[[:space:]]*{/a\\
  if (process.env.CLAUDE_CODE_USE_LOCAL) return
  }" "$METRICS" 2>/dev/null || true
  echo "  [+] patched metrics opt-out"
else
  echo "  [~] metrics already patched"
fi

# 6. Rebrand UI — title, system prompt, logo
echo "  [*] applying Claudex branding..."

# Title: LogoV2
LOGOV2="$CLAUDE_DIR/components/LogoV2/LogoV2.tsx"
if [ -f "$LOGOV2" ]; then
  sed -i '' 's/("Claude Code")/("Claudex")/g' "$LOGOV2"
  sed -i '' 's/" Claude Code "/" Claudex "/g' "$LOGOV2"
  echo "  [+] rebranded LogoV2 title"
fi

# Title: CondensedLogo
CONDENSED="$CLAUDE_DIR/components/LogoV2/CondensedLogo.tsx"
if [ -f "$CONDENSED" ]; then
  sed -i '' 's/>Claude Code</>Claudex</g' "$CONDENSED"
  echo "  [+] rebranded CondensedLogo title"
fi

# System prompt: constants/system.ts
SYSTEM="$CLAUDE_DIR/constants/system.ts"
if [ -f "$SYSTEM" ]; then
  sed -i '' "s/You are Claude Code, Anthropic's official CLI for Claude/You are Claudex, an open-source CLI for local LLMs/g" "$SYSTEM"
  echo "  [+] rebranded system prompt"
fi

# System prompt: constants/prompts.ts
PROMPTS="$CLAUDE_DIR/constants/prompts.ts"
if [ -f "$PROMPTS" ]; then
  sed -i '' "s/You are Claude Code, Anthropic's official CLI for Claude/You are Claudex, an open-source CLI for local LLMs/g" "$PROMPTS"
  sed -i '' 's/using Claude Code/using Claudex/g' "$PROMPTS"
  sed -i '' "s/an agent for Claude Code, Anthropic's official CLI for Claude/an agent for Claudex, an open-source CLI for local LLMs/g" "$PROMPTS"
  echo "  [+] rebranded prompts"
fi

# System prompt: coordinator
COORD="$CLAUDE_DIR/coordinator/coordinatorMode.ts"
if [ -f "$COORD" ]; then
  sed -i '' 's/You are Claude Code, an AI assistant/You are Claudex, an AI assistant/g' "$COORD"
  echo "  [+] rebranded coordinator"
fi

# Welcome screen: WelcomeV2
WELCOME="$CLAUDE_DIR/components/LogoV2/WelcomeV2.tsx"
if [ -f "$WELCOME" ]; then
  sed -i '' 's/Welcome to Claude Code/Welcome to Claudex/g' "$WELCOME"
  echo "  [+] rebranded welcome screen"
fi

# Version check: skip for local builds
UPDATER="$CLAUDE_DIR/utils/autoUpdater.ts"
if [ -f "$UPDATER" ] && ! grep -q "CLAUDE_CODE_USE_LOCAL" "$UPDATER" 2>/dev/null; then
  sed -i '' "s/process.env.NODE_ENV === 'test'/process.env.NODE_ENV === 'test' || process.env.CLAUDE_CODE_USE_LOCAL/" "$UPDATER"
  echo "  [+] disabled version check for local"
fi

# Commander -d2e flag fix
MAIN="$CLAUDE_DIR/main.tsx"
if [ -f "$MAIN" ]; then
  sed -i '' 's/-d2e, --debug-to-stderr/--debug-to-stderr/g' "$MAIN"
  echo "  [+] fixed commander flag"
fi

echo ""
echo "Done. Now build:"
echo "  cd $CLAUDE_DIR"
echo "  bun build claudex-entry.ts --outfile claudex.js --target node --bundle \\"
echo "    --external 'bun:*' --external '@ant/*' \\"
echo "    --define 'MACRO.VERSION=\"1.0.0-local\"' --define 'MACRO.GIT_HASH=\"local\"'"

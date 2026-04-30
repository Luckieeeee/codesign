// Non-secret defaults for the codesign collab Container App.
//
// The image tag, ACR creds, and Supabase secrets MUST be overridden on the
// CLI (later `--parameters key=value` flags take precedence over the values
// in this file):
//
//   az deployment group create \
//     -g codesign-rg -f infra/collab.bicep \
//     -p infra/collab.dev.bicepparam \
//     -p containerImage=...   acrLoginServer=...   acrUsername=... \
//     -p acrPassword=...      supabaseUrl=...      supabaseServiceRoleKey=...
using './collab.bicep'

param appName        = 'codesign'
param cpuCores       = '0.5'
param memoryGi       = '1'
param minReplicas    = 1
param maxReplicas    = 1
param collabPort     = 1234
// TODO: tighten once the Vercel domain is known, e.g.
//   ['https://codesign.vercel.app']
param allowedOrigins = ['*']

// ── Placeholders — always overridden on the CLI ─────────
param containerImage         = 'OVERRIDE_ON_CLI'
param acrLoginServer         = 'OVERRIDE_ON_CLI'
param acrUsername            = 'OVERRIDE_ON_CLI'
param acrPassword            = 'OVERRIDE_ON_CLI'
param supabaseUrl            = 'OVERRIDE_ON_CLI'
param supabaseServiceRoleKey = 'OVERRIDE_ON_CLI'

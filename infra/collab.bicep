// ──────────────────────────────────────────────────────────
// Codesign Collaboration Server — Azure Container Apps
//
// Resources:
//   - Log Analytics workspace (logs sink)
//   - Container Apps environment
//   - Container App running scripts/collab-server.ts
//
// The collab server serves HTTP REST API + Hocuspocus WebSocket on a
// SINGLE TCP port (default 1234), with /health on the same port.
// ──────────────────────────────────────────────────────────

@description('Base name for all resources (e.g. "codesign")')
param appName string = 'codesign'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Container image to deploy (e.g. "codesignacr7d7dff4b.azurecr.io/codesign-collab:abc1234")')
param containerImage string

@description('ACR login server (e.g. "codesignacr7d7dff4b.azurecr.io")')
param acrLoginServer string

@description('ACR username (admin user). Empty = use managed identity instead.')
param acrUsername string = ''

@secure()
@description('ACR admin password. Empty = use managed identity instead.')
param acrPassword string = ''

// ── Application secrets ─────────────────────────────────
@secure()
@description('Supabase project URL (e.g. https://xxx.supabase.co)')
param supabaseUrl string

@secure()
@description('Supabase service role key (server-side only)')
param supabaseServiceRoleKey string

// ── Sizing ──────────────────────────────────────────────
@description('CPU cores for the container')
@allowed(['0.25', '0.5', '1', '2'])
param cpuCores string = '0.5'

@description('Memory in Gi for the container')
@allowed(['0.5', '1', '2', '4'])
param memoryGi string = '1'

@description('Minimum number of replicas. Keep at 1 unless using Redis-backed Hocuspocus — multiple replicas without sticky sessions will fork Y.Doc state.')
@minValue(0)
@maxValue(10)
param minReplicas int = 1

@description('Maximum number of replicas. See note on minReplicas.')
@minValue(1)
@maxValue(10)
param maxReplicas int = 1

@description('Internal TCP port the collab server listens on (matches COLLAB_WS_PORT)')
param collabPort int = 1234

@description('CORS allowed origins. Use ["*"] for hackathon, narrow to Vercel domain for prod.')
param allowedOrigins array = ['*']

// ──────────────────────────────────────────────────────────
// Log Analytics Workspace
// ──────────────────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-collab-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ──────────────────────────────────────────────────────────
// Container Apps Environment
// ──────────────────────────────────────────────────────────
resource containerAppEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-collab-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ──────────────────────────────────────────────────────────
// Container App — Collaboration Server
// ──────────────────────────────────────────────────────────
resource collabApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${appName}-collab'
  location: location
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      activeRevisionsMode: 'Single'

      registries: empty(acrUsername) ? [] : [
        {
          server: acrLoginServer
          username: acrUsername
          passwordSecretRef: 'acr-password'
        }
      ]

      secrets: concat(
        empty(acrPassword) ? [] : [
          { name: 'acr-password', value: acrPassword }
        ],
        [
          { name: 'supabase-url', value: supabaseUrl }
          { name: 'supabase-service-role-key', value: supabaseServiceRoleKey }
        ]
      )

      ingress: {
        external: true
        targetPort: collabPort
        // 'auto' lets Container Apps front HTTP/1.1, HTTP/2 and WebSocket on
        // the same FQDN — exactly what the collab server needs.
        transport: 'auto'
        // Single replica today, but turn this on if you ever scale out so
        // a given client always lands on the same Y.Doc owner.
        stickySessions: {
          affinity: 'sticky'
        }
        corsPolicy: {
          allowedOrigins: allowedOrigins
          allowedMethods: ['GET', 'POST', 'OPTIONS']
          allowedHeaders: ['*']
        }
      }
    }

    template: {
      containers: [
        {
          name: 'collab-server'
          image: containerImage
          resources: {
            cpu: json(cpuCores)
            memory: '${memoryGi}Gi'
          }
          env: [
            { name: 'SUPABASE_URL',              secretRef: 'supabase-url' }
            { name: 'SUPABASE_SERVICE_ROLE_KEY', secretRef: 'supabase-service-role-key' }
            { name: 'COLLAB_WS_PORT',            value: string(collabPort) }
            { name: 'COLLAB_WS_HOST',            value: '0.0.0.0' }
            { name: 'NODE_ENV',                  value: 'production' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                port: collabPort
                path: '/health'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                port: collabPort
                path: '/health'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

// ──────────────────────────────────────────────────────────
// Outputs
// ──────────────────────────────────────────────────────────
output collabAppFqdn  string = collabApp.properties.configuration.ingress.fqdn
output collabWsUrl    string = 'wss://${collabApp.properties.configuration.ingress.fqdn}'
output collabHttpUrl  string = 'https://${collabApp.properties.configuration.ingress.fqdn}'
output environmentId  string = containerAppEnv.id

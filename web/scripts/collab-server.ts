/**
 * Minimal y-websocket-compatible server for the collaborative React Flow demo.
 *
 * Run with:
 *   bun run dev:ws
 *
 * Re-implements the small subset of the y-websocket binary protocol that
 * browsers using `y-websocket` need (sync step 1/2, sync update, awareness
 * update). It speaks the same wire format, so any standard y-websocket client
 * can connect to it.
 *
 * One Y.Doc per room is kept in-memory only; restarting wipes state.
 */

import { createServer, type IncomingMessage } from "node:http"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import { WebSocket, WebSocketServer } from "ws"
import * as Y from "yjs"

const PORT = Number(process.env.COLLAB_WS_PORT ?? 1234)
const HOST = process.env.COLLAB_WS_HOST ?? "0.0.0.0"

// y-websocket message types
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

class Room {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly conns: Map<WebSocket, Set<number>> = new Map()

  constructor(public readonly name: string) {
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null)

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      this.broadcast(message, origin instanceof WebSocket ? origin : null)
    })

    this.awareness.on(
      "update",
      (
        {
          added,
          updated,
          removed,
        }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changedClients = added.concat(updated, removed)
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
        )
        const message = encoding.toUint8Array(encoder)
        this.broadcast(message, origin instanceof WebSocket ? origin : null)
      },
    )
  }

  broadcast(message: Uint8Array, exclude: WebSocket | null) {
    for (const conn of this.conns.keys()) {
      if (conn === exclude) continue
      if (conn.readyState !== WebSocket.OPEN) continue
      try {
        conn.send(message)
      } catch (err) {
        console.warn(`[collab-server] send failed: ${(err as Error).message}`)
      }
    }
  }

  addConnection(conn: WebSocket) {
    this.conns.set(conn, new Set())

    // 1. Send sync step 1 → client will respond with step 2 + an update.
    {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeSyncStep1(encoder, this.doc)
      conn.send(encoding.toUint8Array(encoder))
    }

    // 2. Send current awareness state to the new client.
    const awarenessStates = this.awareness.getStates()
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awarenessStates.keys()),
        ),
      )
      conn.send(encoding.toUint8Array(encoder))
    }
  }

  removeConnection(conn: WebSocket) {
    const controlled = this.conns.get(conn)
    this.conns.delete(conn)
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        Array.from(controlled),
        conn,
      )
    }
  }

  handleMessage(conn: WebSocket, data: Uint8Array) {
    try {
      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)
      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder()
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn)
          // syncProtocol writes a response (e.g. sync step 2) into the encoder.
          if (encoding.length(encoder) > 1) {
            conn.send(encoding.toUint8Array(encoder))
          }
          break
        }
        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(decoder)
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, conn)
          // Track which clientIds belong to this connection so we can clean
          // them up on disconnect.
          const tracked = this.conns.get(conn)
          if (tracked) {
            for (const clientId of this.awareness.getStates().keys()) {
              const meta = (
                this.awareness as unknown as {
                  meta: Map<number, { clock: number; lastUpdated: number }>
                }
              ).meta
              if (meta?.has(clientId)) tracked.add(clientId)
            }
          }
          break
        }
        default:
          console.warn(`[collab-server] unknown message type: ${messageType}`)
      }
    } catch (err) {
      console.error(`[collab-server] message handler error:`, err)
    }
  }
}

const rooms = new Map<string, Room>()

const getRoom = (name: string): Room => {
  let room = rooms.get(name)
  if (!room) {
    room = new Room(name)
    rooms.set(name, room)
    console.log(`[collab-server] room created: "${name}"`)
  }
  return room
}

const parseRoomName = (req: IncomingMessage): string => {
  const url = req.url ?? "/"
  const path = url.split("?")[0] ?? "/"
  const name = path.replace(/^\/+/, "")
  return name.length > 0 ? decodeURIComponent(name) : "default-room"
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" })
  res.end("collab-server ok\n")
})

const wss = new WebSocketServer({ noServer: true })

wss.on("connection", (conn: WebSocket, req: IncomingMessage) => {
  const roomName = parseRoomName(req)
  const room = getRoom(roomName)

  conn.binaryType = "arraybuffer"
  room.addConnection(conn)

  conn.on("message", (data: ArrayBuffer | Buffer | Buffer[]) => {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
    else if (Array.isArray(data)) bytes = new Uint8Array(Buffer.concat(data))
    else bytes = new Uint8Array(data)
    room.handleMessage(conn, bytes)
  })

  const cleanup = () => {
    room.removeConnection(conn)
    if (room.conns.size === 0) {
      rooms.delete(roomName)
      console.log(`[collab-server] room emptied: "${roomName}"`)
    }
  }
  conn.on("close", cleanup)
  conn.on("error", cleanup)
})

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req)
  })
})

httpServer.listen(PORT, HOST, () => {
  console.log(`[collab-server] listening on ws://${HOST}:${PORT}`)
})

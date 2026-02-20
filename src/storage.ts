import fs from "fs/promises"
import path from "path"
import {
  accountsPath,
  authJsonPath,
  STORE_VERSION,
  type Account,
  type AccountStore,
} from "./types"

async function ensureDir(filepath: string) {
  await fs.mkdir(path.dirname(filepath), { recursive: true })
}

async function readJson<T>(filepath: string): Promise<T | undefined> {
  try {
    const data = await fs.readFile(filepath, "utf-8")
    return JSON.parse(data) as T
  } catch {
    return undefined
  }
}

async function writeJson(filepath: string, data: unknown) {
  await ensureDir(filepath)
  const tmp = filepath + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmp, filepath)
}

export async function load(): Promise<AccountStore> {
  const data = await readJson<AccountStore>(accountsPath())
  if (!data || data.version !== STORE_VERSION) {
    return { version: STORE_VERSION, accounts: [] }
  }
  return data
}

export async function save(store: AccountStore) {
  await writeJson(accountsPath(), store)
  await syncAuthJson(store)
}

export async function add(account: Account) {
  const store = await load()
  const existing = store.accounts.findIndex((a) => a.id === account.id)
  if (existing >= 0) {
    store.accounts[existing] = account
  } else {
    store.accounts.push(account)
  }
  await save(store)
  return store
}

export async function remove(id: string) {
  const store = await load()
  store.accounts = store.accounts.filter((a) => a.id !== id)
  store.accounts.forEach((a, i) => { a.priority = i })
  await save(store)
  return store
}

export async function list(): Promise<Account[]> {
  const store = await load()
  return store.accounts.sort((a, b) => a.priority - b.priority)
}

export async function reorder(ids: string[]) {
  const store = await load()
  const map = new Map(store.accounts.map((a) => [a.id, a]))
  const reordered: Account[] = []
  for (const id of ids) {
    const account = map.get(id)
    if (account) {
      account.priority = reordered.length
      reordered.push(account)
      map.delete(id)
    }
  }
  for (const account of map.values()) {
    account.priority = reordered.length
    reordered.push(account)
  }
  store.accounts = reordered
  await save(store)
  return store
}

async function syncAuthJson(store: AccountStore) {
  const primary = store.accounts.sort((a, b) => a.priority - b.priority)[0]
  if (!primary) return

  const auth = (await readJson<Record<string, unknown>>(authJsonPath())) ?? {}
  auth["github-copilot"] = {
    type: "oauth",
    refresh: primary.token,
    access: primary.token,
    expires: 0,
    ...(primary.domain !== "github.com" && { enterpriseUrl: primary.domain }),
  }
  await writeJson(authJsonPath(), auth)
}

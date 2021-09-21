import fs, { createReadStream } from "fs"
import { IncomingMessage, Server as HTTPServer, ServerResponse } from "http"
import { Server as HTTPSServer } from "https"
import { load as parseYAML, YAMLException } from "js-yaml"
import { lookup as lookupType } from "mime-types"
import { dirname, resolve as resolvePath } from "path"
import { assert, dateToString } from "./lib"

const { readFile, stat } = fs.promises

type Config = {
	redirects: Record<string, string>
	symlinks: Record<string, string>
	httpPort: number
	httpsPort: number
	apis: Record<string, string>
	headers: Record<string, string>
	webDirectory: string
	logHeaders: boolean
}

type JSONValue = string | number | boolean | null | JSONValue[] | {
	[key: string]: JSONValue
}

// TODO type: "module" in package.json

const loadedModules = new Map<string, { name: string, api: Function }>()

let config: Record<string, JSONValue> = {}
let configFileLastUpdated = NaN

;(async () => {
	const [ key, cert ] = await Promise.all([
		readFile(resolvePath("privkey.pem"), { encoding: "utf-8" }).catch(() => ""),
		readFile(resolvePath("fullchain.pem"), { encoding: "utf-8" }).catch(() => ""),
		loadConfigLoop()
	])

	const httpPort = Number(config.httpPort) || 80

	if (key && cert) {
		const httpsPort = Number(config.httpsPort) || 443

		log(`start HTTP redirect server on port ${httpPort}`)
		log(`start HTTPS server on port ${httpsPort}`)

		new HTTPServer((req, res) => {
			log(`[${req.connection.remoteAddress}] ${req.method} ${req.url || "/"} HTTP/${req.httpVersion}`)

			if (config.logHeaders)
				log(`header: ${req.rawHeaders.join(", ")}`)

			if (req.headers.host) {
				const href = `https://${req.headers.host}${req.url || ""}`

				log(`301 redirect from HTTP to ${href}`)
				res.writeHead(301, { Location: href })
			}

			res.end()
		}).listen(httpPort)

		new HTTPSServer({ key, cert }, processRequest).listen(httpsPort)
	} else {
		log(`start HTTP server on port ${httpPort}`)
		new HTTPServer(processRequest).listen(httpPort)
	}
})()

async function loadConfigLoop() {
	let configTemp

	const configFileModifiedTime = (await stat(resolvePath("config.yml"))).mtimeMs

	if (configFileModifiedTime != configFileLastUpdated) {
		log("load config file")

		configFileLastUpdated = configFileModifiedTime

		const yamlWarnings: string[] = []

		try {
			configTemp = parseYAML(await readFile(resolvePath("config.yml"), { encoding: "utf-8" }), { onWarning(error) { yamlWarnings.push(error.message) } })
		} catch (error) {
			assert(error instanceof YAMLException, "error was not a YAMLException")
			console.error(`failed to parse config file: ${error.message}`)
		}

		if (isRecord(configTemp)) {
			if (yamlWarnings.length) {
				console.warn("\nyaml parse warnings:\n")
				console.warn(yamlWarnings.join("\n"), "\n")
			}

			config = configTemp as Record<string, JSONValue>
		} else
			log("did not load config file")

		if (isRecord(config.apis)) {
			const toUnload = new Set(loadedModules.keys())

			for (const [ url, name ] of Object.entries(config.apis)) {
				toUnload.delete(url)

				if (typeof name == "string") {
					const module = loadedModules.get(url)

					if (!module || module.name != name)
						loadModule(url, name)
				}
			}

			for (const url of toUnload) {
				log(`unload module at '${url}'`)
				loadedModules.delete(url)
			}
		}
	}

	setTimeout(loadConfigLoop, 10000)
}

async function loadModule(url: string, name: string) {
	loadedModules.set(url, {
		name,
		api: await import(name).then((api: unknown) => {
			if (typeof api == "function") {
				log(`load module '${name}' at '${url}'`)
				return api
			}

			log(`fail to load module '${name}', is not a function`)
			return () => ({ ok: false, msg: "this api failed to load" })
		}, error => {
			log(`fail to load module:`)
			console.error(error)
			return () => ({ ok: false, msg: "this api failed to load" })
		})
	})
}

// TODO x real ip
// FIXME headers comma list no colon
// TODO after I fix protocol in redirect url, I need to add a config to force protocol

function processRequest(request: IncomingMessage, response: ServerResponse) {
	console.log(request.constructor.name)
	log(`[${request.connection.remoteAddress}] ${request.method} ${request.url || "/"} HTTP/${request.httpVersion}`)

	if (config.logHeaders)
		log(`header: ${request.rawHeaders.join(", ")}`)

	if (request.headers.host) {
		let host = request.headers.host

		switch (request.method) {
			case "GET": {
				let redirect: string | null = null

				if (isRecord(config.redirects)) {
					let potentialRedirect = config.redirects[host]

					if (typeof potentialRedirect == "string")
						redirect = potentialRedirect
				}

				if (redirect) {
					const href = `${redirect}${request.url || ""}`

					log(`301 redirect from ${host} to ${href}`)
					response.writeHead(301, { Location: href }).end()
				} else {
					let dir = host
					let symlink: string | null = null

					if (isRecord(config.symlinks)) {
						let potSymlink = config.symlinks[dir]

						if (typeof potSymlink == "string")
							symlink = potSymlink
					}

					if (symlink)
						dir = symlink

					dir += request.url || ""

					if (dir.slice(-1) == "/")
						dir += "index.html"

					const range = request.headers.range
					const path = resolvePath(String(config.webDirectory || "web"), dir)

					stat(path).then(stats => {
						if (stats.isFile()) {
							const options: Parameters<typeof createReadStream>[1] = {}

							response.setHeader("Content-Type", lookupType(dir) || "text/plain")
							// TODO fix redirecting to https when on http mode
							response.setHeader("Content-Location", `https://${dir}`)

							if (isRecord(config.headers))
								for (const [ header, content ] of Object.entries(config.headers))
									if (typeof content == "string")
										response.setHeader(header, content)

							if (range) {
								const [ startStr, endStr ] = range.replace(/bytes=/, "").split("-")

								let start = parseInt(startStr)
								let end = parseInt(endStr)

								end = isNaN(end) ? stats.size - 1 : end
								start = isNaN(start) ? stats.size - end : start

								options.start = start
								options.end = end

								log(`206 serve partial content from ${dir} (${start}-${end}/${stats.size})`)

								response.writeHead(206, {
									"Content-Range": `bytes ${start}-${end}/${stats.size}`,
									"Accept-Ranges": "bytes",
									"Content-Length": end - start + 1,
								})
							} else {
								log(`200 serve ${dir}`)
								response.writeHead(200, { "Content-Length": stats.size })
							}

							createReadStream(path, options).pipe(response)
						} else {
							// TODO fix redirecting to https when on http mode
							const href = `https://${dir}/`

							log(`301 redirect to ${href} since request was a directory - A`)

							response.writeHead(301, { Location: href })
								.end(`301 moved permanently\n${href}`)
						}
					}, (reason: NodeJS.ErrnoException | null) => {
						let href: string

						switch (reason?.code) {
							case "ENOENT":
								log(`404 ${dir} does not exist`)

								readFile(resolvePath("meta/404.html")).catch(() => "").then(
									value => response.writeHead(404, { "Content-Type": "text/html" }).end(value),
									() => response.writeHead(404, { "Content-Type": "text/plain" }).end("404 not found")
								)

								break
							case "ENOTDIR":
								// TODO fix redirecting to https when on http mode
								href = `https://${dirname(dir)}`

								response.writeHead(301, { Location: href })
									.end(`301 moved permanently\n${href}`)
								break
							case "EISDIR":
								// TODO fix redirecting to https when on http mode
								href = `https://${dir}/`

								log(`301 redirect to ${href} since request was a directory - B`)

								response.writeHead(301, { Location: href })
									.end(`301 moved permanently\n${href}`)
								break
							default:
								log("500 let samual know if you see this:")
								console.log(reason)

								readFile(resolvePath("web/_status/500.html")).then(
									value => response.writeHead(500, { "Content-Type": "text/html" }).end(value),
									() => response.writeHead(500, { "Content-Type": "text/plain" }).end("500 internal server error")
								)
						}
					})
				}
			} break

			case "POST": {
				let data = ""
				let url = `${host}${request.url}`

				log(`answer POST request to ${url} from ${request.connection.remoteAddress}`)

				request.on("data", (chunk: Buffer) => data += chunk.toString()).on("end", () => {
					const module = loadedModules.get(url)

					if (module)
						Promise.resolve(module.api(data)).then(value => response.end(JSON.stringify(value))).catch(reason => console.log(reason))
					else
						response.end(`{"ok":false,"msg":"no api on this url"}`)
				})
			}
		}
	} else
		response.end()
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value == "object" && !Array.isArray(value)
}

function log(message: string) {
	console.log(`[${dateToString(new Date())}] ${message}`)
}

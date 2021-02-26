import { Server as HTTPServer, IncomingMessage, ServerResponse } from "http"
import { Server as HTTPSServer } from "https"
import { lookup as lookupType } from "mime-types"
import { resolve as resolvePath, dirname } from "path"
import { URL } from "url"
import { createReadStream } from "fs"
import { load as loadYaml } from "yamljs"
import { readFile, stat } from "fs/promises"
import { validate } from "./lib"

type Config = {
	redirects: Record<string, string>
	symlinks: Record<string, string>
	httpPort: number
	httpsPort: number
	apis: Record<string, string>
	headers: Record<string, string>
}

type JSONValue = string | number | boolean | null | JSONValue[] | {
	[key: string]: JSONValue
}

const loadedModules = new Map<string, {
	name: string
	api(args: any): unknown
}>()

Promise.all([
	readFile(resolvePath("privkey.pem"), { encoding: "utf-8" }).catch(() => ""),
	readFile(resolvePath("fullchain.pem"), { encoding: "utf-8" }).catch(() => "")
]).then(([ key, cert ]) => {
	let httpPort = Number(config.httpPort) || 80
	let httpsPort = Number(config.httpsPort) || 443

	if (key && cert) {
		console.log(`Starting HTTP redirect server on port ${httpPort}`)
		console.log(`Starting HTTPS server on port ${httpsPort}`)

		new HTTPServer((req, res) => {
			if (req.headers.host) {
				const href = `https://${req.headers.host}${req.url || ""}`

				log(301, req, `redirecting from HTTP to ${href}`)
				res.writeHead(301, { Location: href })
			}

			res.end()
		}).listen(httpPort)

		new HTTPSServer({ key, cert }, processRequest).listen(httpsPort)
	} else {
		console.log(`Starting HTTP server on port ${httpPort}`)
		new HTTPServer(processRequest).listen(httpPort)
	}
})

let config: Record<string, JSONValue> = {}

loadConfigLoop()

function loadConfigLoop() {
	let configTemp

	try {
		configTemp = loadYaml(resolvePath("config.yml")) as JSONValue
	} catch (error) {
		console.log("Did not load config file: incorrect format", error?.parsedLine || "")
	}

	if (validate(configTemp))
		config = configTemp
	else
		console.log("Did not load config file: incorrect format")

	if (isJSONObject(config.apis)) {
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
			console.log(`unloading module at '${url}'`)
			loadedModules.delete(url)
		}
	}

	setTimeout(loadConfigLoop, 10000)
}

function loadModule(url: string, name: string) {
	let api

	try {
		api = require(name)

		if (typeof api == "function")
			console.log(`loaded module '${name}' at '${url}'`)
		else {
			api = () => ({ ok: false, msg: "this api failed to load" })
			console.log(`failed to load module '${name}', was not a function`)
		}
	} catch {
		api = () => ({ ok: false, msg: "this api failed to load" })
		console.log(`failed to load module '${name}', did not exist`)
	}

	loadedModules.set(url, { name, api })
}

function processRequest(req: IncomingMessage, res: ServerResponse) {
	if (req.headers.host) {
		let host = req.headers.host

		switch (req.method) {
			case "GET": {
				let redirect: string | null = null

				if (isJSONObject(config.redirects)) {
					let potRedirect = config.redirects[host]

					if (typeof potRedirect == "string")
						redirect = potRedirect
				}

				if (redirect) {
					const href = `${redirect}${req.url || ""}`

					log(301, req, `redirected from ${host} to ${href}`)
					res.writeHead(301, { Location: href }).end()
				} else {
					let dir = host
					let symlink: string | null = null

					if (isJSONObject(config.symlinks)) {
						let potSymlink = config.symlinks[dir]

						if (typeof potSymlink == "string")
							symlink = potSymlink
					}

					if (symlink)
						dir = symlink

					dir += new URL(req.url?.replace(/\.\./g, "") || "/").pathname || "/"

					if (dir.slice(-1) == "/")
						dir += "index.html"

					const range = req.headers.range
					const path = resolvePath("web", dir)

					stat(path).then(stats => {
						if (stats.isFile()) {
							const options: Parameters<typeof createReadStream>[1] = {}

							res.setHeader("Content-Type", lookupType(dir) || "text/plain")
							res.setHeader("Content-Location", `https://${dir}`)

							if (isJSONObject(config.headers))
								for (const [ header, content ] of Object.entries(config.headers))
									if (typeof content == "string")
										res.setHeader(header, content)

							if (range) {
								const [ startStr, endStr ] = range.replace(/bytes=/, "").split("-")

								let start = parseInt(startStr)
								let end = parseInt(endStr)

								end = isNaN(end) ? stats.size - 1 : end
								start = isNaN(start) ? stats.size - end : start

								options.start = start
								options.end = end

								log(206, req, `serving partial content from ${dir} (${start}-${end}/${stats.size})`)

								res.writeHead(206, {
									"Content-Range": `bytes ${start}-${end}/${stats.size}`,
									"Accept-Ranges": "bytes",
									"Content-Length": end - start + 1,
								})
							} else {
								log(200, req, `serving ${dir}`)
								res.writeHead(200, { "Content-Length": stats.size })
							}

							createReadStream(path, options).pipe(res)
						} else {
							const href = `https://${dir}/`

							log(301, req, `redirecting to ${href} since request was a directory - A`)

							res.writeHead(301, { Location: href })
								.end(`302 moved permanently\n${href}`)
						}
					}, (reason: NodeJS.ErrnoException | null) => {
						let href: string

						switch (reason?.code) {
							case "ENOENT":
								log(404, req, `${dir} does not exist`)

								readFile(resolvePath("meta/404.html")).catch(() => "").then(
									value => res.writeHead(404, { "Content-Type": "text/html" }).end(value),
									() => res.writeHead(404, { "Content-Type": "text/plain" }).end("404 not found")
								)

								break
							case "ENOTDIR":
								href = `https://${dirname(dir)}`

								res.writeHead(301, { Location: href })
									.end(`301 moved permanently\n${href}`)
								break
							case "EISDIR":
								href = `https://${dir}/`

								log(301, req, `redirecting to ${href} since request was a directory - B`)

								res.writeHead(301, { Location: href })
									.end(`302 moved permanently\n${href}`)
								break
							default:
								log(500, req, "let samual know if you see this:")
								console.log(reason)

								readFile(resolvePath("web/_status/500.html")).then(
									value => res.writeHead(500, { "Content-Type": "text/html" }).end(value),
									() => res.writeHead(500, { "Content-Type": "text/plain" }).end("500 internal server error")
								)
						}
					})
				}
			} break

			case "POST": {
				let data = ""
				let url = `${host}${req.url}`

				console.log(`answering POST request to ${url} from ${req.socket.remoteAddress}`)

				req.on("data", (chunk: Buffer) => data += chunk.toString()).on("end", () => {
					const module = loadedModules.get(url)

					if (module)
						Promise.resolve(module.api(data)).then(value => res.end(JSON.stringify(value))).catch(reason => console.log(reason))
					else
						res.end(`{"ok":false,"msg":"no api on this url"}`)
				})
			}
		}
	} else
		res.end()
}

function log(statusCode: number, req: IncomingMessage, msg: string) {
	console.log(`[${(new Date).toTimeString().split(" ")[0]}] [${Math.round(Date.now() / 1000).toString(36)}] [${statusCode}] [${req.connection.remoteAddress || "unavailable"}] ${msg}`)
}

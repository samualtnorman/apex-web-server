import fs, { createReadStream } from "fs"
import { IncomingMessage, Server as HTTPServer, ServerResponse } from "http"
import { Server as HTTPSServer } from "https"
import ipaddr from "ipaddr.js"
import { load as parseYAML, YAMLException } from "js-yaml"
import { lookup as lookupType } from "mime-types"
import { dirname, resolve as resolvePath } from "path"
import { assert, dateToString, isRecord } from "./lib"

const { readFile, stat } = fs.promises

declare global {
	interface Config {
		redirects: Map<string, string>
		symlinks: Map<string, string>
		httpPort: number
		httpsPort: number
		apis: Map<string, string>
		headers: Map<string, string>
		webDirectory: string
		logHeaders: boolean
	}
}

interface configEntryVerifierMap extends Map<keyof Config, (value: any) => Config[keyof Config]> {
	get<K extends keyof Config>(key: K): (value: any) => Config[K]
}

// TODO type: "module" in package.json

const loadedModules = new Map<string, { name: string, api: Function }>()

const configEntryVerifiers: configEntryVerifierMap = new Map()

let config!: Config
let configFileLastUpdated = NaN

log("apex start")

;(async () => {
	const [ key, cert ] = await Promise.all([
		readFile(resolvePath(`privkey.pem`), { encoding: `utf-8` }).catch(() => ``),
		readFile(resolvePath(`fullchain.pem`), { encoding: `utf-8` }).catch(() => ``),
		loadConfigLoop()
	])

	const httpPort = config.httpPort

	if (key && cert) {
		const httpsPort = config.httpsPort

		log(`start HTTP redirect server on port ${httpPort}`)
		log(`start HTTPS server on port ${httpsPort}`)

		new HTTPServer((req, res) => {
			log(`[${req.connection.remoteAddress}] ${req.method} ${req.url || `/`} HTTP/${req.httpVersion}`)

			if (config.logHeaders)
				log(`header: ${req.rawHeaders.join(`, `)}`)

			if (req.headers.host) {
				const href = `https://${req.headers.host}${req.url || ``}`

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

	const configFileModifiedTime = (await stat(resolvePath(`config.yml`))).mtimeMs

	if (configFileModifiedTime != configFileLastUpdated) {
		log(`load config file`)

		configFileLastUpdated = configFileModifiedTime

		const yamlWarnings: string[] = []

		try {
			configTemp = parseYAML(await readFile(resolvePath(`config.yml`), { encoding: `utf-8` }), { onWarning(error) { yamlWarnings.push(error.message) } })
		} catch (error) {
			assert(error instanceof YAMLException, `error was not a YAMLException`)
			logError(`failed to parse config file: ${error.message}`)
		}

		if (yamlWarnings.length) {
			console.warn(`\nconfig parse warnings:\n`)
			console.warn(yamlWarnings.join(`\n`), `\n`)
		}

		config = {
			redirects: new Map<string, string>(),
			symlinks: new Map<string, string>(),
			httpPort: 80,
			httpsPort: 443,
			apis: new Map<string, string>(),
			headers: new Map<string, string>(),
			webDirectory: "web",
			logHeaders: false
		} as Config

		if (!isRecord(configTemp)) {
			logError(`config warning: should have entries`)
			return config
		}

		const propertyNames = new Set(Object.getOwnPropertyNames(configTemp))

		if ("redirects" in configTemp) {
			propertyNames.delete("redirects")

			if (isRecord(configTemp.redirects)) {
				for (const [ key, value ] of Object.entries(configTemp.redirects)) {
					if (typeof value == "string")
						config.redirects.set(key, value)
					else
						logError(`config warning: "${key}" in "redirects" entry should be a string`)
				}
			} else
				logError(`config warning: "redirects" should have entries`)
		}

		if ("symlinks" in configTemp) {
			propertyNames.delete("symlinks")

			if (isRecord(configTemp.symlinks)) {
				for (const [ key, value ] of Object.entries(configTemp.symlinks)) {
					if (typeof value == "string")
						config.symlinks.set(key, value)
					else
					logError(`config warning: "${key}" in "symlinks" entry should be a string`)
				}
			} else
				logError(`config warning: "symlinks" should have entries`)
		}

		if ("httpPort" in configTemp) {
			propertyNames.delete("httpPort")

			if (typeof configTemp.httpPort == "number")
				config.httpPort = configTemp.httpPort
			else
				logError(`config warning: "httpPort" should be a number`)
		}

		if ("httpsPort" in configTemp) {
			propertyNames.delete("httpsPort")

			if (typeof configTemp.httpsPort == "number")
				config.httpsPort = configTemp.httpsPort
			else
				logError(`config warning: "httpsPort" should be a number`)
		}

		if ("apis" in configTemp) {
			propertyNames.delete("apis")

			if (isRecord(configTemp.apis)) {
				for (const [ key, value ] of Object.entries(configTemp.apis)) {
					if (typeof value == "string")
						config.apis.set(key, value)
					else
						logError(`config warning: "${key}" in "apis" entry should be a string`)
				}
			} else
				logError(`config warning: "apis" should have entries`)
		}

		if ("headers" in configTemp) {
			propertyNames.delete("headers")

			if (isRecord(configTemp.headers)) {
				for (const [ key, value ] of Object.entries(configTemp.headers)) {
					if (typeof value == "string")
						config.headers.set(key, value)
					else
						logError(`config warning: "${key}" in "headers" entry should be a string`)
				}
			} else
				logError(`config warning: "headers" should have entries`)
		}

		if ("webDirectory" in configTemp) {
			propertyNames.delete("webDirectory")

			if (typeof configTemp.webDirectory == "string")
				config.webDirectory = configTemp.webDirectory
			else
				logError(`config warning: "webDirectory" should be a string`)
		}

		if ("logHeaders" in configTemp) {
			propertyNames.delete("logHeaders")

			if (typeof configTemp.logHeaders == "boolean")
				config.logHeaders = configTemp.logHeaders
			else
				logError(`config warning: "logHeaders" should be a boolean`)
		}

		const toUnload = new Set(loadedModules.keys())

		for (const [ url, name ] of config.apis) {
			toUnload.delete(url)

			const module = loadedModules.get(url)

			if (!module || module.name != name)
				await loadModule(url, name)
		}

		for (const url of toUnload) {
			log(`unload module at '${url}'`)
			loadedModules.delete(url)
		}

		for (const [ name, verifier ] of configEntryVerifiers) {
			(config as any)[name] = verifier(configTemp[name])
			propertyNames.delete(name)
		}

		for (const propertyName of propertyNames)
			logError(`config warning: unrecognised entry "${propertyName}"`)
	}

	setTimeout(loadConfigLoop, 1000)
}

async function loadModule(url: string, name: string) {
	loadedModules.set(url, {
		name,
		api: await import(name).then((module: { onPost?: unknown }) => {
			if (typeof module.onPost == `function`) {
				log(`load module '${name}' at '${url}'`)
				return module.onPost
			}

			log(`fail to load module '${name}', is not a function`)
			return () => ({ ok: false, msg: `this api failed to load` })
		}, error => {
			log(`fail to load module:`)
			logError(error)
			return () => ({ ok: false, msg: `this api failed to load` })
		})
	})
}

// FIXME headers comma list no colon
// TODO after I fix protocol in redirect url, I need to add a config to force protocol

function processRequest(request: IncomingMessage, response: ServerResponse) {
	if (!request.socket.remoteAddress) {
		response.end()
		return
	}

	let ip: string
	let isLocalConnection: boolean

	const parsedSocketIP = ipaddr.process(request.socket.remoteAddress)
	const socketIPRange = parsedSocketIP.range()

	if (socketIPRange == `private` || socketIPRange == `loopback`) {
		if (`x-real-ip` in request.headers) {
			assert(typeof request.headers[`x-real-ip`] == `string`, `"X-Real-IP" header was not a string`)

			const parsedRealIP = ipaddr.process(request.headers[`x-real-ip`])

			ip = parsedRealIP.toString()
			isLocalConnection = parsedRealIP.range() == `private`
		} else {
			ip = parsedSocketIP.toString()
			isLocalConnection = true
		}
	} else {
		ip = parsedSocketIP.toString()
		isLocalConnection = false
	}

	log(`[${ip}] ${request.method} ${request.url || `/`} HTTP/${request.httpVersion}`)

	if (config.logHeaders)
		log(`header: ${request.rawHeaders.join(`, `)}`)

	if (request.headers.host) {
		let host = request.headers.host

		switch (request.method) {
			case `GET`: {
				if (config.redirects.has(host)) {
					const href = `${config.redirects.get(host)}${request.url || ``}`

					log(`301 redirect from ${host} to ${href}`)
					response.writeHead(301, { Location: href }).end()
				} else {
					let dir = host

					if (config.symlinks.has(dir))
						dir = config.symlinks.get(dir)!

					dir += request.url || `/`

					if (dir.slice(-1) == `/`)
						dir += `index.html`

					const range = request.headers.range
					const path = resolvePath(config.webDirectory, dir)

					stat(path).then(stats => {
						if (stats.isFile()) {
							const options: Parameters<typeof createReadStream>[1] = {}

							response.setHeader(`Content-Type`, lookupType(dir) || `text/plain`)
							// TODO fix redirecting to https when on http mode
							response.setHeader(`Content-Location`, `https://${dir}`)

							for (const [ header, content ] of config.headers.entries())
								response.setHeader(header, content)

							if (range) {
								const [ startStr, endStr ] = range.replace(/bytes=/, ``).split(`-`)

								let start = parseInt(startStr)
								let end = parseInt(endStr)

								end = isNaN(end) ? stats.size - 1 : end
								start = isNaN(start) ? stats.size - end : start

								options.start = start
								options.end = end

								log(`206 serve partial content from ${dir} (${start}-${end}/${stats.size})`)

								response.writeHead(206, {
									"Content-Range": `bytes ${start}-${end}/${stats.size}`,
									"Accept-Ranges": `bytes`,
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
							case `ENOENT`:
								log(`404 ${dir} does not exist`)

								readFile(resolvePath(`meta/404.html`)).catch(() => ``).then(
									value => response.writeHead(404, { "Content-Type": `text/html` }).end(value),
									() => response.writeHead(404, { "Content-Type": `text/plain` }).end(`404 not found`)
								)

								break
							case `ENOTDIR`:
								// TODO fix redirecting to https when on http mode
								href = `https://${dirname(dir)}`

								response.writeHead(301, { Location: href })
									.end(`301 moved permanently\n${href}`)
								break
							case `EISDIR`:
								// TODO fix redirecting to https when on http mode
								href = `https://${dir}/`

								log(`301 redirect to ${href} since request was a directory - B`)

								response.writeHead(301, { Location: href })
									.end(`301 moved permanently\n${href}`)
								break
							default:
								log(`500 let samual know if you see this:`)
								log(reason)

								readFile(resolvePath(`web/_status/500.html`)).then(
									value => response.writeHead(500, { "Content-Type": `text/html` }).end(value),
									() => response.writeHead(500, { "Content-Type": `text/plain` }).end(`500 internal server error${isLocalConnection ? `\n${reason?.stack}` : ``}`)
								)
						}
					})
				}
			} break

			case `POST`: {
				let data = ``
				let url = `${host}${request.url}`

				log(`answer POST request to ${url} from ${ip}`)

				request.on(`data`, (chunk: Buffer) => data += chunk.toString()).on(`end`, () => {
					const module = loadedModules.get(url)

					if (!module) {
						response.end(`{"ok":false,"msg":"no api on this url"}`)
						return
					}

					let returnValue

					try {
						returnValue = module.api(data, { isLocalConnection, ip, config })
					} catch (error) {
						logError(`Caught`, error)
						response.end(`{"ok":false,"msg":"internal server error"}`)
						return
					}

					Promise.resolve(returnValue).then(JSON.stringify).then(
						json => response.end(json),
						reason => {
							logError(`Caught`, reason)
							response.end(`{"ok":false,"msg":"internal server error"}`)
						}
					)
				})
			}
		}
	} else
		response.end()
}

export function log(...message: any[]) {
	console.log(`[${dateToString(new Date())}]`, ...message)
}

export function logError(...message: any[]) {
	console.error(`[${dateToString(new Date())}]`, ...message)
}

export function registerConfigEntryVerifier<T extends keyof Config>(name: T, verifier: (value: unknown) => Config[T]) {
	if (configEntryVerifiers.has(name))
		throw new Error(`config entry verifier already registered on "${name}"`)

	configEntryVerifiers.set(name, verifier)

	return function deregisterConfigEntryVerifier() {
		configEntryVerifiers.delete(name)
	}
}

export function getConfig() {
	return config
}

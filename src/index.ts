import { Server as HTTPServer } from "http"
import { Server as HTTPSServer } from "https"
import { lookup as lookupType } from "mime-types"
import { resolve as resolvePath, dirname } from "path"
import { parse as parseURL } from "url"
import { promises, createReadStream } from "fs"
import { load as loadYaml } from "yamljs"
import { formatWithOptions } from "util"

interface LooseObject<T = any> {
	[key: string]: T
}

interface Config {
	redirects: LooseObject<string>
	symlinks: LooseObject<string>
	httpPort: number
	httpsPort: number
}

const { readFile, stat } = promises

Promise.all([ readFile(resolvePath(__dirname, "privkey.pem")), readFile(resolvePath(__dirname, "fullchain.pem") )]).then(([ key, cert ]) => {
	new HTTPServer((req, res) => {
		if (req.headers.host) {
			const href = `https://${req.headers.host}${req.url || ""}`

			console.log(301, req.headers.host, "->", href)
			res.writeHead(301, { Location: href })
		}

		res.end()
	}).listen(80)

	new HTTPSServer({ key, cert }, (req, res) => {
		if (req.headers.host) {
			if (typeof config.redirects[req.headers.host] == "string") {
				const href = config.redirects[req.headers.host] + (req.url || "")

				console.log(301, req.headers.host, "->", href)
				res.writeHead(301, { Location: href })
				res.end()
			} else {
				let dir = req.headers.host

				if (typeof config.symlinks?.[dir] == "string")
					dir = config.symlinks[dir]

				dir += parseURL(req.url?.replace(/\.\./g, "") || "/").pathname || "/"

				if (dir.slice(-1) == "/")
					dir += "index.html"
				
				const range = req.headers.range
				const path = resolvePath(__dirname, "web", dir)

				stat(path).then(stats => {
					if (stats.isFile()) {
						const options: Parameters<typeof createReadStream>[1] = {}

						res.setHeader("Content-Type", lookupType(dir) || "text/plain")
						res.setHeader("Content-Location", `https://${dir}`)
						
						if (range) {
							const [ startStr, endStr ] = range.replace(/bytes=/, "").split("-")

							let start = parseInt(startStr)
							let end = parseInt(endStr)

							end = isNaN(end) ? stats.size - 1 : end
							start = isNaN(start) ? stats.size - end : start

							options.start = start
							options.end = end

							console.log(206, dir, `${start}-${end}/${stats.size}`)

							res.writeHead(206, {
								"Content-Range": `bytes ${start}-${end}/${stats.size}`,
								"Accept-Ranges": "bytes",
								"Content-Length": end - start + 1,
							})
						} else {
							console.log(200, dir)
							res.writeHead(200, { "Content-Length": stats.size })
						}

						createReadStream(path, options).pipe(res)
					} else {
						const href = `https://${dir}/`

						console.log(301, dir, "->", href)

						res.writeHead(301, { Location: href })
						res.end(`302 moved permanently\n${href}`)
					}
				}, (reason: NodeJS.ErrnoException | null) => {
					let href: string

					console.log(JSON.stringify(reason))

					switch (reason?.errno) {
						case -2:
						case -21:
						case -4058:
							console.log(404, dir)

							readFile(resolvePath(__dirname,  "meta/404.html"))
								.then(
									value => {
										res.writeHead(404, { "Content-Type": "text/html" })
										res.end(value)
									},
									() => {
										res.writeHead(404, { "Content-Type": "text/plain" })
										res.end("404 not found")
									}
								)

							break
						case -20:
							href = `https://${dirname(dir)}`

							res.writeHead(301, { Location: href })
							res.end(`301 moved permanently\n${href}`)
							break
						case -4068:
							href = `https://${dir}/`

							console.log(301, dir, "->", href)

							res.writeHead(301, { Location: href })
							res.end(`302 moved permanently\n${href}`)
							break
						default:
							console.log(500, reason)

							readFile(resolvePath(__dirname,  "web/_status/500.html"))
								.then(
									value => {
										res.writeHead(500, { "Content-Type": "text/html" })
										res.end(value)
									},
									() => {
										res.writeHead(500, { "Content-Type": "text/plain" })
										res.end("500 internal server error")
									}
								)
					}
				})
			}
		} else
			res.end()
	}).listen(443)
})

let config: Config

refreshTimeoutLoop()

function refreshTimeoutLoop() {
	config = loadYaml("config.yml")
	setTimeout(refreshTimeoutLoop, 10000)
}

import { Server as HTTPServer } from "http"
import { Server as HTTPSServer } from "https"
import { lookup } from "mime-types"
import { resolve, dirname } from "path"
import { parse } from "url"
import { promises as fs, createReadStream } from "fs"
import { load } from "yamljs"

interface LooseObject<T = any> {
	[key: string]: T
}

interface Config {
	redirects: LooseObject<string>
	symlinks: LooseObject<string>
}

Promise.all([ fs.readFile(resolve(__dirname, "privkey.pem")), fs.readFile(resolve(__dirname, "fullchain.pem") )]).then(([ key, cert ]) => {
	new HTTPServer((req, res) => {
		if (req.headers.host) {
			const href = `https://${req.headers.host}${req.url || ""}`

			console.log(301, req.headers.host, "->", href)
			res.writeHead(301, { Location: href })
		}

		res.end()
	}).listen(80)

	new HTTPSServer({ key, cert }, (req, res) => {
		const { redirects, symlinks }: Config = load("config.yml")

		if (req.headers.host) {
			if (redirects[req.headers.host]) {
				const href = redirects[req.headers.host]

				console.log(301, req.headers.host, "->", href)
				res.writeHead(301, { Location: href })
				res.end()
			} else {
				let dir: string

				if (symlinks[req.headers.host])
					dir = symlinks[req.headers.host]
				else {
					dir = req.headers.host
					dir += parse(req.url?.replace(/\.\./g, "") || "/").pathname || "/"
				}

				if (dir.slice(-1) == "/")
					dir += "index.html"
				
				const range = req.headers.range
				const path = resolve(__dirname, "web", dir)

				if (range) {
					fs.stat(path).then(({ size }) => {
						const [ startStr, endStr ] = range.replace(/bytes=/, "").split("-");
						let start = parseInt(startStr)
						let end = parseInt(endStr)

						end = isNaN(end) ? size - 1 : end
						start = isNaN(start) ? size - end : start
	
						if (start >= size || end >= size) {
							console.log(416, dir, `${start}-${end}/${size}`)
							res.writeHead(416, { "Content-Range": `bytes */${size}` })
							res.end()
						} else {
							console.log(206, dir, `${start}-${end}/${size}`)

							res.writeHead(206, {
								"Content-Range": `bytes ${start}-${end}/${size}`,
								"Accept-Ranges": "bytes",
								"Content-Length": end - start + 1,
								"Content-Type": lookup(dir) || "text/plain"
							})
		
							createReadStream(path, { start, end }).pipe(res)
						}
					}).catch(err => console.error(err))
				} else {
					fs.readFile(path).then(value => {
						console.log(200, dir)
						res.writeHead(200, { "Content-Type": lookup(dir) || "text/plain" })
						res.end(value)
					}, (reason: NodeJS.ErrnoException | null) => {
						let href: string

						switch (reason?.errno) {
							case -2:
							case -21:
							case -4058:
								console.log(404, dir)

								fs.readFile(resolve(__dirname,  "web/_status/404.html"))
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

								console.log(301, dir, "->", href)

								res.writeHead(301, { Location: href })
								res.end(`302 moved permanently\n${href}`)
								break
							case -4068:
								href = `https://${dir}/`

								console.log(301, dir, "->", href)

								res.writeHead(301, { Location: href })
								res.end(`302 moved permanently\n${href}`)
								break
							default:
								console.log(500, reason)

								fs.readFile(resolve(__dirname,  "web/_status/500.html"))
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
			}
		} else
			res.end()
	}).listen(443)
})

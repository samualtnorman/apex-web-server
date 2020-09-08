
import { request as makeHTTPSRequest } from "https"

request("Hello, World!")


function request(inputData: string) {
	let data = ""

	return new Promise<string>((resolve, reject) => {
		makeHTTPSRequest({
			method: "POST",
			hostname: "samual.uk",
			path: "/"
		}, res => res.on("data", (chunk: Buffer) => data += chunk.toString()).on("end", () => {
			console.log(data)
		})).end(JSON.stringify(inputData))
	})
}

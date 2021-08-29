import { createInterface } from "readline"

const rl = createInterface({
	input: process.stdin,
	output: process.stdout
})

// rl.question("test ", (answer) => {
// 	console.log(`test: ${answer}`);

// 	rl.close();
// })

rl.write("test")

// import { exec } from "child_process"
// import { resolve as resolvePath } from "path"
// import { list, start, disconnect, stop, connect, startup } from "pm2"
// import { userInfo, platform } from "os"

// const modulePath = resolvePath(__dirname, "..")

// type ArgValue = boolean | number | string/* | ArgValue[]*/

// const options = new Map<string, ArgValue>()
// const commands: string[] = []

// const { username } = userInfo()

// for (let arg of process.argv.slice(2)) {
// 	if (arg[0] == "-") {
// 		let [ key, valueRaw ] = arg.split("=")
// 		let value: ArgValue

// 		if (valueRaw)
// 			if (valueRaw == "true")
// 				value = true
// 			else if (valueRaw == "false")
// 				value = false
// 			else {
// 				let number = Number(valueRaw)

// 				if (isFinite(number))
// 					value = number
// 				else
// 					value = valueRaw
// 			}
// 		else
// 			value = true

// 		if (arg[1] == "-")
// 			options.set(key.slice(2), value)
// 		else
// 			for (let option of key.slice(1))
// 				options.set(option, value)
// 	} else
// 		commands.push(arg)
// }

// connect((error: Error | null) => {
// 	if (error) {
// 		console.log(error)
// 		disconnect()
// 	} else {
// 		if (commands[0] == "setup") {
// 			if (options.get("force") || process.platform != "win32" && username == "root") {
// 				startup("ubuntu", (error, info) => {
// 					console.log(error, info)
// 					disconnect()
// 				})
// 			} else {
// 				console.log("This command requires root (use --force to override)\ne.g. sudo apex setup")
// 				disconnect()
// 			}
// 		} else if (process.platform != "win32" && username == "root") {
// 			console.log("Refusing to run as root, to fix permission issues use sudo apex setup")
// 			disconnect()
// 		} else {
// 			switch (commands[0]) {
// 				case "start":
// 					start(resolvePath(modulePath, "index.js"), {
// 						name: "apex"
// 					}, (error: Error | null, proc) => {
// 						if (error)
// 							console.log(error)

// 						disconnect()
// 					})
// 					break
// 				case "status":
// 					list((error: Error | null, info) => {
// 						if (error)
// 							throw error

// 						console.log(`Server ${info[0].pm2_env?.status || "not started"}.`)

// 						disconnect()
// 					})
// 					break
// 				case "stop":
// 					stop(0, (error: Error | null, info) => {
// 						if (error)
// 							throw error

// 						console.log(info)
// 					})
// 				case "log":
// 					exec
// 					disconnect()
// 					break
// 				default:
// 					console.log("nothing")
// 					disconnect()
// 			}
// 		}
// 	}
// })

import { connect } from 'cloudflare:sockets';

const proxyIPs = ['98.98.118.82', '98.98.119.110'];
let proxyIP    = proxyIPs[Math.floor(Math.random() * proxyIPs.length)]; // Proxy IP Rotator
let userID     = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let dohURL     = 'https://dns.google/dns-query'; // https://cloudflare-dns.com/dns-query or https://dns.google/dns-query

if (!isValidUUID(userID)) {
	throw new Error('UUID Salah !!!');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			userID          = env.UUID || userID;
			proxyIP         = env.PROXYIP || proxyIP;
			dohURL          = env.DNS_RESOLVER_URL || dohURL;
			let userID_Path = userID;

			// Multiple UUID
			if (userID.includes(',')) {
				userID_Path = userID.split(',')[0];
			}

			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/info':
						return new Response(JSON.stringify(request.cf, null, 4), {
							status: 200,
							headers: {
								"Content-Type": "application/json;charset=utf-8",
							},
						});
					case `/status/${userID_Path}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/html; charset=utf-8",
							}
						});
					}
					case `/sub/${userID_Path}`: {
						const url          = new URL(request.url);
						const searchParams = url.searchParams;
						let vlessConfig    = createVLESSSub(userID, request.headers.get('Host'));

						if (searchParams.get('format') === 'clash') {
							vlessConfig = btoa(vlessConfig);
						}

						return new Response(vlessConfig, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						const newHeaders = new Headers(request.headers);
						const hostnames  = ['bits.co.id', 'nurulimam.my.id'];
						url.hostname     = hostnames[Math.floor(Math.random() * hostnames.length)];
						url.protocol     = 'https:';

						newHeaders.set('cf-connecting-ip', newHeaders.get('x-forwarded-for') || newHeaders.get('cf-connecting-ip'));
						newHeaders.set('x-forwarded-for', newHeaders.get('cf-connecting-ip'));
						newHeaders.set('x-real-ip', newHeaders.get('cf-connecting-ip'));
						newHeaders.set('referer', 'https://www.google.com/q=bantenitsolutions');

						request = new Request(url, {
							method: request.method,
							headers: newHeaders,
							body: request.body,
							redirect: request.redirect,
						});

						const cache  = caches.default;
						let response = await cache.match(request);

						if (!response) {
							try {
								response = await fetch(request, { redirect: 'manual' });
							} catch (err) {
								url.protocol = 'http:';
								url.hostname = hostnames[Math.floor(Math.random() * hostnames.length)];
								request = new Request(url, {
									method: request.method,
									headers: newHeaders,
									body: request.body,
									redirect: request.redirect,
								});
								response = await fetch(request, { redirect: 'manual' });
							}

							const cloneResponse = response.clone();
							ctx.waitUntil(cache.put(request, cloneResponse));
						}
						return response;
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			let e = err;
			return new Response(e.toString());
		}
	},
};

/**
 * Handles VLESS over WebSocket requests by creating a WebSocket pair, accepting the WebSocket connection, and processing the VLESS header.
 * @param {import("@cloudflare/workers-types").Request} request The incoming request object.
 * @returns {Promise<Response>} A Promise that resolves to a WebSocket response object.
 */
async function vlessOverWSHandler(request) {
	const webSocketPair       = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();

	let address           = '';
	let portWithRandomLog = '';
	let currentDate       = new Date();
	const log = (info, event) => {
		console.log(`[${currentDate} ${address}:${portWithRandomLog}] ${info}`, event || '');
	};

	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWapper = {
		value: null,
	};

	let udpStreamWrite = null;
	let isDns = false;

	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}

			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);

			address = addressRemote;
			portWithRandomLog = `${portRemote} ${isUDP ? 'udp' : 'tcp'} `;

			if (hasError) {
				throw new Error(message);
				return;
			}

			if (isUDP && portRemote !== 53) {
				throw new Error('UDP proxy only enabled for DNS which is port 53');
			}

			if (isUDP && portRemote === 53) {
				isDns = true;
			}

			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {

	/**
	 * Connects to a given address and port and writes data to the socket.
	 * @param {string} address The address to connect to.
	 * @param {number} port The port to connect to.
	 * @returns {Promise<import("@cloudflare/workers-types").Socket>} A Promise that resolves to the connected socket.
	 */
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	/**
	 * Retries connecting to the remote address and port if the Cloudflare socket has no incoming data.
	 * @returns {Promise<void>} A Promise that resolves when the retry is complete.
	 */
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * Creates a readable stream from a WebSocket server, allowing for data to be read from the WebSocket.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer The WebSocket server to create the readable stream from.
 * @param {string} earlyDataHeader The header containing early data for WebSocket 0-RTT.
 * @param {(info: string)=> void} log The logging function.
 * @returns {ReadableStream} A readable stream that can be used to read data from the WebSocket.
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				const message = event.data;
				controller.enqueue(message);
			});

			webSocketServer.addEventListener('close', () => {
				safeCloseWebSocket(webSocketServer);
				controller.close();
			});

			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
		},

		cancel(reason) {
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;
}

/**
 * Processes the VLESS header buffer and returns an object with the relevant information.
 * @param {ArrayBuffer} vlessBuffer The VLESS header buffer to process.
 * @param {string} userID The user ID to validate against the UUID in the VLESS header.
 * @returns {{
 *  hasError: boolean,
 *  message?: string,
 *  addressRemote?: string,
 *  addressType?: number,
 *  portRemote?: number,
 *  rawDataIndex?: number,
 *  vlessVersion?: Uint8Array,
 *  isUDP?: boolean
 * }} An object with the relevant information extracted from the VLESS header buffer.
 */
function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'Invalid Data',
		};
	}

	const version            = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser          = false;
	let isUDP                = false;
	const slicedBuffer       = new Uint8Array(vlessBuffer.slice(1, 17));
	const slicedBufferString = stringify(slicedBuffer);
	const uuids              = userID.includes(',') ? userID.split(",") : [userID];
	isValidUser              = uuids.some(userUuid => slicedBufferString === userUuid.trim()) || uuids.length === 1 && slicedBufferString === uuids[0].trim();

	console.log(`userID: ${slicedBufferString}`);

	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	if (command === 1) {
		isUDP = false;
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}

	const portIndex  = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer).getUint16(0);
	let addressIndex = portIndex + 2;

	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);

	const addressType     = addressBuffer[0];
	let addressLength     = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue      = '';

	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			break;
		default:
			return {
				hasError: true,
				message: `Invalid  addressType is ${addressType}`,
			};
	}

	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 * Converts a remote socket to a WebSocket connection.
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket The remote socket to convert.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to connect to.
 * @param {ArrayBuffer | null} vlessResponseHeader The VLESS response header.
 * @param {(() => Promise<void>) | null} retry The function to retry the connection if it fails.
 * @param {(info: string) => void} log The logging function.
 * @returns {Promise<void>} A Promise that resolves when the conversion is complete.
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let remoteChunkCount = 0;
	let chunks           = [];
	let vlessHeader      = vlessResponseHeader;
	let hasIncomingData  = false;
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				async write(chunk, controller) {
					hasIncomingData = true;
					remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * Decodes a base64 string into an ArrayBuffer.
 * @param {string} base64Str The base64 string to decode.
 * @returns {{earlyData: ArrayBuffer|null, error: Error|null}} An object containing the decoded ArrayBuffer or null if there was an error, and any error that occurred during decoding or null if there was no error.
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { earlyData: null, error: null };
	}
	try {
		base64Str        = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode     = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { earlyData: null, error };
	}
}

/**
 * Checks if a given string is a valid UUID.
 * Note: This is not a real UUID validation.
 * @param {string} uuid The string to validate as a UUID.
 * @returns {boolean} True if the string is a valid UUID, false otherwise.
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

/**
 * Closes a WebSocket connection safely without throwing exceptions.
 * @param {import("@cloudflare/workers-types").WebSocket} socket The WebSocket connection to close.
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];

for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}

/**
 * Handles outbound UDP traffic by transforming the data into DNS queries and sending them over a WebSocket connection.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket connection to send the DNS queries over.
 * @param {ArrayBuffer} vlessResponseHeader The VLESS response header.
 * @param {(string) => void} log The logging function.
 * @returns {{write: (chunk: Uint8Array) => void}} An object with a write method that accepts a Uint8Array chunk to write to the transform stream.
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});

	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch(dohURL,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isVlessHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isVlessHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
		log('dns udp has error' + error)
	});

	const writer = transformStream.writable.getWriter();

	return {
		write(chunk) {
			writer.write(chunk);
		}
	};
}

/**
 *
 * @param {string} userID - single or comma separated userIDs
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userIDs, hostName) {
	const commonUrlPart = `:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F#${hostName}`;
	const vlessMain     = `vless://${userIDs}@${hostName}${commonUrlPart}`;
	const vlessSub      = `https://${hostName}/sub/${userIDs}`;
	const vlessClash    = `https://${hostName}/sub/${userIDs}?format=clash`;

	const htmlHead = `
    <head>
        <title>BITS Vless Cloudflare Workers</title>
        <meta name="description" content="This is a tool for generating VLESS protocol configurations">
		<meta name="keywords" content="Vless, cloudflare pages, cloudflare worker, severless">
        <meta name="viewport" content="width=device-width, initial-scale=1">
		<meta property="og:site_name" content="BITS Vless Cloudflare Workers" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="BITS Vless Cloudflare Workers" />
        <meta property="og:description" content="Use cloudflare pages and worker severless to implement vless protocol" />
        <meta property="og:url" content="https://${hostName}/" />
        <meta property="og:image" content="https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(`vless://${userIDs.split(',')[0]}@${hostName}${commonUrlPart}`)}" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="BITS Vless Cloudflare Workers" />
        <meta name="twitter:description" content="Use cloudflare pages and worker severless to implement vless protocol" />
        <meta name="twitter:url" content="https://${hostName}/" />
        <meta name="twitter:image" content="https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(`vless://${userIDs.split(',')[0]}@${hostName}${commonUrlPart}`)}" />
        <meta property="og:image:width" content="500" />
        <meta property="og:image:height" content="500" />
		<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous" rel="stylesheet" />
    </head>
    `;

	return `
<!DOCTYPE html>
<html>
    ${htmlHead}
    <body>
      <div class="p-3 bg-primary text-white">
        <div class="fs-4 fw-bold text-center">
          <h2>BITS Vless - Cloudflare Workers</h2>
        </div>
        <div class="fs-6 text-center">
          Simple Vless with Cloudflare Workers. Web Developed by <a href="https://bits.co.id" target="_blank" class="text-white">Nurul Imam</a> - <a href="https://bits.co.id" target="_blank" class="text-white">Banten IT Solutions</a>.
        </div>
      </div>
      
      <div class="form-group col-md-6 mx-auto px-4 py-3">
        <label for="uuid" class="form-label fw-bold">
          UUID
        </label>
        <div class="input-group">
          <div class="input-group-prepend">
            <button class="btn btn-outline-secondary" type="button" onclick="var tmp=document.getElementById('uuid');tmp.select();tmp.setSelectionRange(0,99999);navigator.clipboard.writeText(tmp.value)">Copy</button>
          </div>
          <input type="text" class="form-control" id="uuid" readonly value="${userIDs}">
        </div>
      </div>

      <div class="form-group col-md-6 mx-auto px-4 pb-3">
        <label for="vless-link" class="form-label fw-bold">
          Link Vless
        </label>
        <div class="input-group">
          <div class="input-group-prepend">
            <button class="btn btn-outline-secondary" type="button" onclick="var tmp=document.getElementById('vless-link');tmp.select();tmp.setSelectionRange(0,99999);navigator.clipboard.writeText(tmp.value)">Copy</button>
          </div>
          <input type="text" class="form-control" id="vless-link" readonly value="${vlessMain}">
        </div>
      </div>

      <div class="form-group col-md-6 mx-auto px-4 pb-3">
        <label for="sub-link" class="form-label fw-bold">
          Link Subs v2rayN, v2rayNG, v2rayA, Matsuri, Nekobox & Nekoray
        </label>
        <div class="input-group">
          <div class="input-group-prepend">
            <button class="btn btn-outline-secondary" type="button" onclick="var tmp=document.getElementById('sub-link');tmp.select();tmp.setSelectionRange(0,99999);navigator.clipboard.writeText(tmp.value)">Copy</button>
          </div>
          <input type="text" class="form-control" id="sub-link" readonly value="${vlessSub}">
        </div>
      </div>

      <div class="form-group col-md-6 mx-auto px-4 pb-3">
        <label for="clash-link" class="form-label fw-bold">
          Link Subs Clash, ClashX & ClashMeta
        </label>
        <div class="input-group">
          <div class="input-group-prepend">
            <button class="btn btn-outline-secondary" type="button" onclick="var tmp=document.getElementById('clash-link');tmp.select();tmp.setSelectionRange(0,99999);navigator.clipboard.writeText(tmp.value)">Copy</button>
          </div>
          <input type="text" class="form-control" id="clash-link" readonly value="${vlessClash}">
        </div>
      </div>

      <div class="form-group col-md-6 mx-auto px-4 pb-3">
        <label for="details-link" class="form-label fw-bold">
          Vless Details
        </label>
        <pre><code>
- name: BITS Vless
  type: vless
  server: ${hostName}
  port: 443
  uuid: ${userIDs}
  alterId: 0
  cipher: auto
  udp: false
  tls: true
  skip-cert-verify: true
  servername: ${hostName}
  network: ws
  client-fingerprint: chrome
  ws-opts:
    path: "/"
    headers:
      Host: ${hostName}
		</code></pre>
      </div>
    </body>
</html>`;
}

function createVLESSSub(userID_Path, hostName) {
	let portArray_http  = [80, 8080, 8880, 2052, 2086, 2095, 2082];
	let portArray_https = [443, 8443, 2053, 2096, 2087, 2083];
	let userIDArray     = userID_Path.includes(',') ? userID_Path.split(',') : [userID_Path];
	let output          = [];

	userIDArray.forEach((userID) => {
		// Check if the hostName is a Cloudflare Pages domain because support only https
		if (!hostName.includes('pages.dev')) {
			portArray_http.forEach((port) => {
				const commonUrlPart_http = `:${port}?encryption=none&security=none&fp=random&type=ws&host=${hostName}&path=%2F#${hostName}-HTTP-${port}`;
				const vlessMainHttp = `vless://${userID}@${hostName}${commonUrlPart_http}`;
				proxyIPs.forEach((proxyIP) => {
					const vlessSecHttp = `vless://${userID}@${proxyIP}${commonUrlPart_http}-${proxyIP}-BITS`;
					output.push(`${vlessMainHttp}`);
					output.push(`${vlessSecHttp}`);
				});
			});
		}

		portArray_https.forEach((port) => {
			const commonUrlPart_https = `:${port}?encryption=none&security=tls&sni=${hostName}&fp=random&type=ws&host=${hostName}&path=%2F#${hostName}-HTTPS-${port}`;
			const vlessMainHttps = `vless://${userID}@${hostName}${commonUrlPart_https}`;
			proxyIPs.forEach((proxyIP) => {
				const vlessSecHttps = `vless://${userID}@${proxyIP}${commonUrlPart_https}-${proxyIP}-BITS`;
				output.push(`${vlessMainHttps}`);
				output.push(`${vlessSecHttps}`);
			});
		});
	});
	return output.join('\n');
}

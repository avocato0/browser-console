import puppeteer from 'puppeteer-core';
import { Protocol } from 'devtools-protocol';
import { EventEmitter } from 'events';
import os from 'os';

import SourceMaps from './SourceMaps';
import config from '../config';
import Log from './Log';

export interface IBrowserEvent {
	log: Log;
	update: boolean;
}

export interface IFileLoaderResponse {
	status: number;
	statusText: string;
	ok: boolean;
	content?: string;
}

class Browser extends EventEmitter {
	private browser: puppeteer.Browser;
	private page: puppeteer.Page;
	private CDPclient: puppeteer.CDPSession;
	private serverHash: string;
	private sourceMaps = SourceMaps;

	public on<K extends keyof IBrowserEvent>(
		type: K,
		listener: (arg: IBrowserEvent[K]) => void
	): this {
		return super.on(type, listener);
	}

	public emit<K extends keyof IBrowserEvent>(type: K, arg: IBrowserEvent[K]): boolean {
		return super.emit(type, arg);
	}

	private get defaultBrowserDir() {
		const platform = os.platform();
		return config.pathToChrome[platform];
	}

	public async init(port: number | string, browserDir?: string) {
		this.browser = await puppeteer.launch({
			// headless: false,
			// devtools: true,
			args: config.browserArgs,
			executablePath: browserDir || this.defaultBrowserDir,
		});

		this.page = await this.browser.newPage();

		await this.page.setRequestInterception(true);
		this.page.on('request', this.onScriptRequest);

		// this.page.on('close', () => console.log('close'));
		// this.page.on('domcontentloaded', () => console.log('domcontentloaded'));
		// this.page.on('load', () => console.log('load'));
		// this.page.on('console', console.log);

		this.CDPclient = await this.page.target().createCDPSession();
		await this.CDPclient.send('Runtime.enable');
		await this.CDPclient.send('Network.enable');
		this.CDPclient.on('Runtime.consoleAPICalled', this.onConsoleLog);
		this.CDPclient.on('Network.webSocketFrameReceived', this.onWSReloadPage);

		await this.page.goto(`http://localhost:${port}/`);
	}

	public async close() {
		if (this.browser) {
			await this.browser.close();
		}
	}

	private onWSReloadPage = (event: Protocol.Network.WebSocketFrameReceivedEvent) => {
		// https://github.com/sockjs/sockjs-client/blob/110788c1e6422972c89d7a65365cc5e46bb6f6ec/lib/main.js#L245
		const message = event.response.payloadData;
		if (!message) {
			return;
		}

		const type = message.slice(0, 1);
		const data = message.slice(1);

		if (data && type === 'a') {
			const payloadArr = JSON.parse(data);
			payloadArr.forEach((payload: string) => {
				const parsedPayload = JSON.parse(payload);
				if (parsedPayload.type === 'hash') {
					if (!this.serverHash) {
						this.serverHash = parsedPayload.data;
						return;
					}

					if (parsedPayload.data === this.serverHash) {
						return;
					}

					this.serverHash = parsedPayload.data;
					this.emit('update', true);
				}
			});
		}
	};

	private onScriptRequest = async (request: puppeteer.Request) => {
		const type = request.resourceType();
		if (config.request.ignoreTypes.includes(type)) {
			return request.abort();
		}

		if (type === 'script') {
			const url = request.url();
			const response = await this.loadFile(`${url}.map`);

			if (response && response.ok && response.content) {
				await this.sourceMaps.create(url, response.content);
			}
		}

		return request.continue();
	};

	private getPropsByObjectId = async (
		objectId: Protocol.Runtime.RemoteObjectId,
		isProperty = true
	): Promise<Protocol.Runtime.GetPropertiesResponse | undefined> => {
		if (objectId) {
			return (await this.CDPclient.send('Runtime.getProperties', {
				objectId,
				ownProperties: isProperty,
				accessorPropertiesOnly: !isProperty,
				generatePreview: true,
			} as Protocol.Runtime.GetPropertiesRequest)) as Protocol.Runtime.GetPropertiesResponse;
		}

		console.error('objectId is missing');
	};

	private onConsoleLog = async (event: Protocol.Runtime.ConsoleAPICalledEvent) => {
		const log = new Log(event, this.getPropsByObjectId);
		if (event.type !== 'info') {
			// console.log(event.args);
			// console.log(log.preview);
			// if (!event.args) return;
			// const resp = await this.getPropsByObjectId(event.args[0].objectId);
			// console.log(resp?.result);
		}

		if (log.existOnClient) {
			this.emit('log', log);

			console.log(log.args[0]);
			const resp = await log.getProps(log.preview[0]);
			// console.log(resp);

			// if (!value) return;
			// console.log(log.getPreview(value));
		}
	};

	private async loadFile(url: string): Promise<IFileLoaderResponse | undefined> {
		const page = await this.browser.newPage();
		const response = await page.goto(url);
		if (!response) {
			return;
		}

		const data: IFileLoaderResponse = {
			status: response.status(),
			statusText: response.statusText(),
			ok: response.ok(),
			content: await response.text(),
		};

		await page.close();
		return data;
	}
}

const test = async () => {
	console.clear();

	const browser = new Browser();
	await browser.init(8080);
};
test();

export default Browser;
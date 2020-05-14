import EventEmitter from "eventemitter3";
import sleep from "sleep-promise";
import Terminal from "terminal.js";

import { Line } from "../../common/Line";
import Config from "../../config";
import Socket from "../../socket";
import { decode, encode, keymap as key } from "../../utils";
import { getWidth, indexOfWidth, substrWidth } from "../../utils/char";

import defaultConfig from "./config";
import { Article, Board } from "./model";

class Bot extends EventEmitter {
	static initialState = {
		connect: false,
		login: false
	};
	static forwardEvents = ["message", "error"];

	private config: Config;
	private term: Terminal;
	private _state: any;
	private currentCharset: string;
	private socket: Socket;
	private preventIdleHandler: ReturnType<typeof setTimeout>;

	get line(): Line[] {
		const lines = [];
		for (let i = 0; i < this.term.state.rows; i++) {
			const { str, attr } = this.term.state.getLine(i);
			lines.push({ str, attr: Object.assign({}, attr) });
		}
		return lines;
	}

	get screen(): string {
		return this.line.map(line => line.str).join("\n");
	}

	constructor(config?: Config) {
		super();
		this.config = { ...defaultConfig, ...config };
		this.init();
	}
	reconnect() {
		this.socket.connect();
	}
	async init(): Promise<void> {
		const { config } = this;
		this.term = new Terminal(config.terminal);
		this._state = { ...Bot.initialState };
		this.term.state.setMode("stringWidth", "dbcs");
		this.currentCharset = "big5";

		switch (config.protocol.toLowerCase()) {
			case "websocket":
			case "ws":
			case "wss":
				break;
			case "telnet":
			case "ssh":
			default:
				throw new Error(`Invalid protocol: ${config.protocol}`);
				break;
		}

		const socket = new Socket(config);
		socket.connect();

		Bot.forwardEvents.forEach(e => {
			socket.on(e, this.emit.bind(this, e));
		});
		socket
			.on("connect", (...args) => {
				this._state.connect = true;
				this.emit("connect", ...args);
				this.emit("stateChange", this.state);
			})
			.on("disconnect", (closeEvent, ...args) => {
				this._state.connect = false;
				this._state.login = false;
				this.emit("disconnect", closeEvent, ...args);
				this.emit("stateChange", this.state);
				// // try to reconnect
				// sleep(1000).then(() => {
				// 	this.socket.connect();
				// });
			})
			.on("message", data => {
				if (
					this.currentCharset !== this.config.charset &&
					!this.state.login &&
					decode(data, "utf8").includes("登入中，請稍候...")
				) {
					this.currentCharset = this.config.charset;
				}
				const msg = decode(data, this.currentCharset);
				this.term.write(msg);
				this.emit("redraw", this.term.toString());
			})
			.on("error", err => {
        console.error(err);
      });
		this.socket = socket;
	}

	get state(): any {
		return { ...this._state };
	}

	getLine = n => {
		return this.term.state.getLine(n);
	};

	async getContent(): Promise<Line[]> {
		const lines = [];
		// console.log(this.line);
		lines.push(this.line[0]);

		let sentPgDown = false;
		// var t0 = performance.now()
		while (
			!this.line[23].str.includes("100%") &&
			!this.line[23].str.includes("此文章無內容")
		) {
			// var t2 = performance.now()
			for (let i = 1; i < 23; i++) {
				lines.push(this.line[i]);
			}
			// var t3 = performance.now()
			// console.log('lines.push : ', t3-t2 + 'ms')
			// t3 = performance.now()
			await this.send(key.PgDown);
			// var t4 = performance.now()
			// console.log('await send key pgdown : ', t4-t3 + 'ms')
			// console.log(this.line);
			sentPgDown = true;
		}
		// var t1 = performance.now()
		// console.log('while loop : ', t1-t0 + 'ms')
		const lastLine = lines[lines.length - 1];

		for (let i = 0; i < 23; i++) {
			if (this.line[i].str === lastLine.str) {
				for (let j = i + 1; j < 23; j++) {
					lines.push(this.line[j]);
				}
				break;
			}
		}

		while (lines.length > 0 && lines[lines.length - 1].str === "") {
			lines.pop();
		}

		if (sentPgDown) {
			await this.send(key.Home);
		}

		return lines;
	}

	/**
	 * @deprecated
	 */
	async getLines() {
		const lines = await this.getContent();
		return lines.map(line => line.str);
	}

	send(msg: string): Promise<boolean> {
		if (this.config.preventIdleTimeout) {
			this.preventIdle(this.config.preventIdleTimeout);
		}
		return new Promise((resolve, reject) => {
			let autoResolveHandler;
			const cb = message => {
				clearTimeout(autoResolveHandler);
				resolve(true);
			};
			if (this.state.connect) {
				if (msg.length > 0) {
					this.socket.send(encode(msg, this.currentCharset));
					this.once("message", cb);
					autoResolveHandler = setTimeout(() => {
						this.removeListener("message", cb);
						resolve(false);
					}, this.config.timeout * 10);
				} else {
					console.info(`Sending message with 0-length. Skipped.`);
					resolve(true);
				}
			} else {
				reject();
			}
		});
	}

	preventIdle(timeout: number): void {
		clearTimeout(this.preventIdleHandler);
		if (this.state.login) {
			this.preventIdleHandler = setTimeout(async () => {
				await this.send(key.CtrlU);
				await this.send(key.ArrowLeft);
			}, timeout * 1000);
		}
	}

	async login(
		username: string,
		password: string,
		kick: boolean = true
	): Promise<any> {
		if (this.state.login) {
			return;
		}
		username = username.replace(/,/g, "");
		if (this.config.charset === "utf8") {
			username += ",";
		}
		await this.send(`${username}${key.Enter}${password}${key.Enter}`);
		let ret = await this.checkLogin(kick);
		if (ret) {
			const { _state: state } = this;
			state.login = true;
			state.position = {
				boardname: ""
			};
			this._state.username = username.substring(0, username.length - 1);
			this.emit("stateChange", this.state);
		}
		return ret;
	}

	async logout(): Promise<boolean> {
		if (!this.state.login) {
			return;
		}
		await this.send(`G${key.Enter}Y${key.Enter}`);
		this._state.login = false;
		this.emit("stateChange", this.state);
		this.send(key.Enter);
		return true;
	}

	private async checkLogin(kick: boolean): Promise<boolean> {
		if (
			this.line[21].str.includes("密碼不對或無此帳號") ||
			this.line[21].str.includes("請重新輸入")
		) {
			this.emit("login.failed");
			return false;
		} else if (this.line[23].str.includes("請稍後再試")) {
			this.emit("login.failed");
			return false;
		} else if (this.line[13].str.includes("亂踹密碼會留下記錄喔")) {
			this.emit("login.failed");
			return false;
		} else {
			let state = 0;
			while (true) {
				await sleep(400);
				const lines = this.line;
				if (lines[22].str.includes("登入中，請稍候...")) {
					/* no-op */
				} else if (
					lines[22].str.includes("您想刪除其他重複登入的連線嗎")
				) {
					if (state === 1) continue;
					await this.send(`${kick ? "y" : "n"}${key.Enter}`);
					state = 1;
					continue;
				} else if (
					lines[23].str.includes("請勿頻繁登入以免造成系統過度負荷")
				) {
					if (state === 2) continue;
					await this.send(`${key.Enter}`);
					state = 2;
				} else if (
					lines[23].str.includes("您要刪除以上錯誤嘗試的記錄嗎")
				) {
					if (state === 3) continue;
					await this.send(`y${key.Enter}`);
					state = 3;
				} else if (lines[23].str.includes("按任意鍵繼續")) {
					await this.send(`${key.Enter}`);
				} else if (
					(lines[22].str + lines[23].str)
						.toLowerCase()
						.includes("y/n")
				) {
					console.info(`Unknown login state: \n${this.screen}`);
					await this.send(`y${key.Enter}`);
				} else if (lines[23].str.includes("我是")) {
					break;
				} else {
					console.info(`Unknown login state: \n${this.screen}`);
				}
			}
			this.emit("login.success");
			return true;
		}
	}

	/**
	 * @deprecated
	 */
	private checkArticleWithHeader(): boolean {
		const authorArea = substrWidth("dbcs", this.line[0].str, 0, 6).trim();
		return authorArea === "作者";
	}

	select(model) {
		return model.select(this);
	}

	/**
	 * @deprecated
	 */
	async getMails(offset: number = 0) {
		await this.enterMail();
		if (offset > 0) {
			offset = Math.max(offset - 9, 1);
			await this.send(`${key.End}${key.End}${offset}${key.Enter}`);
		}

		const { getLine } = this;

		const mails = [];
		for (let i = 3; i <= 22; i++) {
			const line = getLine(i).str;
			const mail = {
				sn: +substrWidth("dbcs", line, 1, 5).trim(),
				date: substrWidth("dbcs", line, 9, 5).trim(),
				author: substrWidth("dbcs", line, 15, 12).trim(),
				status: substrWidth("dbcs", line, 30, 2).trim(),
				title: substrWidth("dbcs", line, 33).trim()
			};
			mails.push(mail);
		}

		await this.enterIndex();
		return mails.reverse();
	}

	/**
	 * @deprecated
	 */
	async getMail(sn: number) {
		await this.enterMail();
		const { getLine } = this;

		await this.send(`${sn}${key.Enter}${key.Enter}`);

		const hasHeader = this.checkArticleWithHeader();

		const mail = {
			sn,
			author: "",
			title: "",
			timestamp: "",
			lines: []
		};

		if (this.checkArticleWithHeader()) {
			mail.author = substrWidth("dbcs", getLine(0).str, 7, 50).trim();
			mail.title = substrWidth("dbcs", getLine(1).str, 7).trim();
			mail.timestamp = substrWidth("dbcs", getLine(2).str, 7).trim();
		}

		mail.lines = await this.getLines();

		await this.enterIndex();
		return mail;
	}

	async enterIndex(): Promise<boolean> {
		await this.send(`${key.ArrowLeft.repeat(10)}`);
		return true;
	}

	get currentBoardname(): string | undefined {
		const boardRe = /【(?!看板列表).*】.*《(?<boardname>.*)》/;
		const match = boardRe.exec(this.line[0].str);
		if (match) {
			return match.groups.boardname;
		} else {
			return void 0;
		}
	}

	// From board enter article with AID
	async enterArticleByAIDFromBoard(AID): Promise<string> {
		if (!this.state.login) {
			return Promise.reject("not login");
		}
		const query = `#${AID}${key.Enter}`;
		const res = await this.send(query);
		if (!res) {
			await this.send(`${key.Enter}`);
			return Promise.reject("enterArticleByAIDFromBoard failed");
		}
		await this.send(`${key.ArrowRight}`);
		// console.log("enterArticleByAIDFromBoard", this.screen);
		return Promise.resolve(`now in article : ${AID}`);
	}

	// Enter board and enter article with AID
	async enterArticleByAID(boardname, AID): Promise<string> {
		if (!this.state.login) {
			return Promise.reject("not login");
		}
		try {
			await this.enterBoardByName(boardname);
			await this.enterArticleByAIDFromBoard(AID);
			return Promise.resolve(`now in article : ${AID}`);
		} catch (err) {
			return Promise.reject(err);
		}
  }
  
  // This API is STATEFUL! 
	// send comment in article, in search mode.
	//  res = {
	// 		"type" : "1" or "2" or "3"
	//  	"text" : "hello!"
	//    "boardName" : "test",
	//    "aid" : "aid"
	// }

	async sendCommentSearchMode(res): Promise<string> {
		let text = res.text;
		text = text.trim();
		if (text.length === 0) return Promise.reject("empty string");
		const lenPerLine = 52;
		// 中文字的長度是二
		const seperateText = str => {
			let textParts = [];
			let strPart = "";
			for (var i = 0, len = 0; i < str.length; ) {
				if (str[i] >= "\u00ff") {
					// cannot put it in
					if (len >= lenPerLine - 1) {
						textParts.push(strPart);
						strPart = "";
						len = 0;
					} else {
						strPart += str[i];
						len += 2;
						i++;
					}
				} else {
					if (len == lenPerLine) {
						textParts.push(strPart);
						strPart = "";
						len = 0;
					} else {
						strPart += str[i];
						len += 1;
						i++;
					}
				}
			}
			textParts.push(strPart);
			return textParts;
		};
		text = seperateText(text);
		try {
      // We assume bot is in the correct article.
			for (let t of text) {
				// console.log("X!");
				await this.send("X");

				// console.log("after pressing X", this.screen);
				if (this.line[23].str.includes("您覺得這篇文章")) {
					// console.log(`type ${res.type}`);
					await this.send(`${res.type}`);
				}
				// If this is your article, you can only comment in mode 3(->).
				// Also if you send too many in short period of time, system will force you to use mode 3.
				if (
					this.line[22].str.includes("使用 → 加註方式") ||
					this.line[23].str.includes(this.state.username)
				) {
					// console.log(`${textToSend}`);
					await this.send(`${t}${key.Enter}`);
					await this.send(`y${key.Enter}`);
					// console.log("after send ", this.screen);
				} else {
          // Somehow you cannot send comment. go back to search page.
          // 八卦版有限制要等三秒
          await this.send(`${key.ArrowLeft}`);
        }
			}
			return Promise.resolve("comment success");
		} catch (err) {
			return Promise.reject(err);
		}
	}










	// send comment in article
	//  res = {
	// 		"type" : "1" or "2" or "3"
	//  	"text" : "hello!"
	//    "boardName" : "test",
	//    "aid" : "aid"
	// }

	async sendComment(res): Promise<string> {
		if (!this.state.login) {
			return Promise.reject("not login");
		}
		let text = res.text;
		text = text.trim();
		if (text.length === 0) return Promise.reject("empty string");
		const lenPerLine = 52;
		// 中文字的長度是二
		const seperateText = str => {
			let textParts = [];
			let strPart = "";
			for (var i = 0, len = 0; i < str.length; ) {
				if (str[i] >= "\u00ff") {
					// cannot put it in
					if (len >= lenPerLine - 1) {
						textParts.push(strPart);
						strPart = "";
						len = 0;
					} else {
						strPart += str[i];
						len += 2;
						i++;
					}
				} else {
					if (len == lenPerLine) {
						textParts.push(strPart);
						strPart = "";
						len = 0;
					} else {
						strPart += str[i];
						len += 1;
						i++;
					}
				}
			}
			textParts.push(strPart);
			return textParts;
		};
		text = seperateText(text);
		try {
			// enter board first
			await this.enterBoardByName(res.boardName);

			for (let t of text) {
				// get in the article by aid
				await this.enterArticleByAIDFromBoard(res.aid);
				// console.log("X!");
				await this.send("X");

				// console.log("after pressing X", this.screen);
				if (this.line[23].str.includes("您覺得這篇文章")) {
					// console.log(`type ${res.type}`);
					await this.send(`${res.type}`);
				}
				// If this is your article, you can only comment in mode 3(->).
				// Also if you send too many in short period of time, system will force you to use mode 3.
				if (
					this.line[22].str.includes("使用 → 加註方式") ||
					this.line[23].str.includes(this.state.username)
				) {
					// console.log(`${textToSend}`);
					await this.send(`${t}${key.Enter}`);
					await this.send(`y${key.Enter}`);
					// console.log("after send ", this.screen);
				}
			}

			await this.enterIndex();
			return Promise.resolve("comment success");
		} catch (err) {
			return Promise.reject(err);
		}
	}

	async enterBoardByName(boardname: string): Promise<string> {
		await this.send(`s${boardname}${key.Enter} ${key.Home}${key.End}`);

		if (this.currentBoardname.toLowerCase() === boardname.toLowerCase()) {
			this._state.position.boardname = this.currentBoardname;
			this.emit("stateChange", this.state);
			return Promise.resolve(`now in board : ${boardname}`);
		} else {
			await this.enterIndex();
			return Promise.reject(`enterBoardByName failed`);
		}
	}

	async enterByOffset(offsets: number[] = []): Promise<boolean> {
		let result = true;
		offsets.forEach(async offset => {
			if (offset === 0) {
				result = false;
			}
			if (offset < 0) {
				for (let i = 22; i >= 3; i--) {
					let lastOffset = substrWidth(
						"dbcs",
						this.line[i].str,
						3,
						4
					).trim();
					if (lastOffset.length > 0) {
						offset += +lastOffset + 1;
						break;
					}
					lastOffset = substrWidth(
						"dbcs",
						this.line[i].str,
						15,
						2
					).trim();
					if (lastOffset.length > 0) {
						offset += +lastOffset + 1;
						break;
					}
				}
			}
			if (offset < 0) {
				result = false;
			}
			if (!result) {
				return;
			}
			await this.send(
				`${offset}${key.Enter.repeat(2)} ${key.Home}${key.End}`
			);
		});

		if (result) {
			this._state.position.boardname = this.currentBoardname;
			this.emit("stateChange", this.state);
			await this.send(key.Home);
			return true;
		} else {
			await this.enterIndex();
			return false;
		}
	}

	async enterBoardByOffset(offsets: number[] = []): Promise<boolean> {
		await this.send(`C${key.Enter}`);
		return await this.enterByOffset(offsets);
	}

	async enterFavorite(offsets: number[] = []): Promise<boolean> {
		await this.send(`F${key.Enter}`);
		return await this.enterByOffset(offsets);
	}

	async enterMail(): Promise<boolean> {
		await this.send(`M${key.Enter}R${key.Enter}${key.Home}${key.End}`);
		return true;
	}
}

export default Bot;

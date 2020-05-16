import { Line } from "../../../common/Line";
import { ObjectLiteral } from "../../../common/ObjectLiteral";
import { SelectQueryBuilder } from "../../../utils/query-builder/SelectQueryBuilder";
import { keymap as key } from "../../../utils";
import { substrWidth } from "../../../utils/char";

export class Article {
	boardname: string;
	id: number;
	push: string;
	date: string;
	timestamp: string;
	author: string;
	status: string;
	title: string;
	fixed: boolean;
	iterator: { next: () => Promise<{ value: []; done: boolean }> };
	sendComment: (arg0: any,arg1: any) => Promise<string>;
	private _content: Line[] = [];

	get content(): ReadonlyArray<Line> {
		return this._content;
	}

	set content(content: ReadonlyArray<Line>) {
		this._content = content.slice();
	}

	get data(): ReadonlyArray<string> {
		return this._content.map(content => content.str);
	}

	/**
	 * @deprecated
	 */
	set data(data: ReadonlyArray<string>) {
		console.warn(
			"Should not set Mail.data/Mail.lines directly. " +
				"Use Mail.content instead"
		);
	}

	constructor() {}

	static fromLine(line: Line): Article {
		const article = new Article();
		const { str } = line;
		article.id = +substrWidth("dbcs", str, 1, 7).trim();
		article.push = substrWidth("dbcs", str, 9, 2).trim();
		article.date = substrWidth("dbcs", str, 11, 5).trim();
		article.author = substrWidth("dbcs", str, 17, 12).trim();
		article.status = substrWidth("dbcs", str, 30, 2).trim();
		article.title = substrWidth("dbcs", str, 32).trim();
		article.fixed = substrWidth("dbcs", str, 1, 7)
			.trim()
			.includes("★");
		return article;
	}

	static select(bot): SelectQueryBuilder<Article> {
		return new ArticleSelectQueryBuilder(bot);
	}

	hasHeader(): boolean {
		if (this.content.length === 0) {
			return false;
		}
		const authorArea = substrWidth(
			"dbcs",
			this.content[0].str,
			0,
			6
		).trim();
		return authorArea === "作者";
	}
}

export enum WhereType {
	Boardname = "boardname",
	Id = "id",
	Push = "push",
	Author = "author",
	Title = "title"
}

export class ArticleSelectQueryBuilder extends SelectQueryBuilder<Article> {
	private bot;
	private boardname = "";
	private wheres: ObjectLiteral[] = [];
	private id = 0;

	constructor(bot) {
		super();
		this.bot = bot;
	}

	where(type: WhereType, condition: any): this {
		switch (type) {
			case WhereType.Boardname:
				if (this.boardname !== "") {
					console.warn(
						`Cannot call where with type "${type}" multiple times`
					);
				} else {
					this.boardname = condition;
				}
				break;
			case WhereType.Id:
				this.id = +condition;
				break;
			case WhereType.Push:
				this.wheres.push({ type: "Z", condition });
				break;
			case WhereType.Author:
				this.wheres.push({ type: "a", condition });
				break;
			case WhereType.Title:
				this.wheres.push({ type: "/", condition });
				break;
			default:
				throw new Error(`Invalid type: ${type}`);
		}
		return this;
	}

	getQuery(): string {
		return this.wheres
			.map(({ type, condition }) => `${type}${condition}${key.Enter}`)
			.join();
	}

	/**
	 * *** This API is STATEFUL. ***
	 	Used when search article.
		Returns an iterator of article list.
	 */
	getIterator() {
		let last_id;
		const iterator = {
			next: async () => {
				try {
					// already receive all parts
					if (last_id === 1) {
						// last part will be ignore
						return { value: null, done: true };
					}

					// first time init
					if (!last_id) {
						await this.bot.enterBoardByName(this.boardname);
						const found = await this.bot.send(this.getQuery());
						console.log("found", found);
						if (!found) return { value: null, done: true };
						// go to bottom to prevent repeatitive search bug
						await this.bot.send(`${key.End}`);
					} else {
						await this.bot.send(`${key.PgUp}`);
					}

					let articles: Article[] = [];
					for (let i = 3; i <= 22; i++) {
						const line = this.bot.line[i];
						// console.log("line", line);
						if (line.str.trim() === "") {
							break;
						}
						const article = Article.fromLine(line);
						article.boardname = this.boardname;
						articles.push(article);
					}
					// console.log("articles", articles);

					last_id = articles[0].id;
					return { value: articles, done: false };
				} catch (err) {
					return Promise.reject(err);
				}
			}
		};
		return iterator;
	}

	/**
	 * *** This API is STATEFUL. ***
	 *  We use this API when clicking an article item of search article list.
		Returns an article.
	 */
	async getOneInSearch(): Promise<Article | undefined> {
		//  This is NOT global id.
		//  It is generated locally when search.
		await this.bot.send(`${this.id}${key.Enter}${key.Enter}`);

		const article = new Article();
		article.id = this.id;
		article.boardname = this.boardname;
		article.content = await this.bot.getContent();

		if (article.hasHeader()) {
			article.author = substrWidth(
				"dbcs",
				this.bot.line[0].str,
				7,
				50
			).trim();
			article.title = substrWidth("dbcs", this.bot.line[1].str, 7).trim();
			article.timestamp = substrWidth(
				"dbcs",
				this.bot.line[2].str,
				7
			).trim();
		}

		// go back to search
		await this.bot.send(`${key.ArrowLeft}`);
		return article;
	}

	// Used when click in boarditem, we will only specify boardname.
	async get(): Promise<Article[]> {
		await this.bot.enterBoardByName(this.boardname);
		const found = await this.bot.send(this.getQuery());
		if (!found) {
			return [];
		}
		if (this.id > 0) {
			const id = Math.max(this.id - 9, 1);
			await this.bot.send(`${key.End}${key.End}${id}${key.Enter}`);
		}

		const articles: Article[] = [];
		for (let i = 3; i <= 22; i++) {
			const line = this.bot.line[i];
			if (line.str.trim() === "") {
				break;
			}
			const article = Article.fromLine(line);
			article.boardname = this.boardname;
			articles.push(article);
		}
		// fix id
		if (articles.length >= 2 && articles[0].id === 0) {
			for (let i = 1; i < articles.length; i++) {
				if (articles[i].id !== 0) {
					articles[0].id = articles[i].id - i;
					break;
				}
			}
		}
		for (let i = 1; i < articles.length; i++) {
			articles[i].id = articles[i - 1].id + 1;
		}

		await this.bot.enterIndex();
		return articles.reverse();
	}

	async getOne(): Promise<Article | undefined> {
		await this.bot.enterBoardByName(this.boardname);
		const found = await this.bot.send(this.getQuery());
		if (!found) {
			return void 0;
		}
		/* TODO: validate id */
		await this.bot.send(`${this.id}${key.Enter}${key.Enter}`);

		const article = new Article();
		article.id = this.id;
		article.boardname = this.boardname;
		article.content = await this.bot.getContent();

		if (article.hasHeader()) {
			article.author = substrWidth(
				"dbcs",
				this.bot.line[0].str,
				7,
				50
			).trim();
			article.title = substrWidth("dbcs", this.bot.line[1].str, 7).trim();
			article.timestamp = substrWidth(
				"dbcs",
				this.bot.line[2].str,
				7
			).trim();
		}

		await this.bot.enterIndex();
		return article;
	}

	async getOneIterator() {
		await this.bot.enterBoardByName(this.boardname);
		const found = await this.bot.send(this.getQuery());
		if (!found) {
			return void 0;
		}
		try {
			// /* TODO: validate id */
			await this.bot.send(`${this.id}${key.Enter}${key.Enter}`);
			const article = new Article();
			article.id = this.id;
			article.boardname = this.boardname;
			article.iterator = await this.bot.getContentIterator();
			article.sendComment = this.sendComment;
			return article;
		} catch (err) {
			return Promise.reject(err);
		}
	}
	// assume that we are in an article now.
	// send comment in article
	//  arg = {
	// 		"type" : "1" or "2" or "3"
	//  	"text" : "hello!"
	//    "boardName" : "test",
	//    "aid" : "aid"
	// }
	async sendComment(arg,bot): Promise<string> {
		
		if (!bot.state.login) {
			return Promise.reject("not login");
		}
		let text = arg.text;
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
			for (let t of text) {
				// console.log("X!");
				await bot.send("X");

				console.log("after pressing X", bot.screen);
				if (bot.line[23].str.includes("您覺得這篇文章")) {
					// console.log(`type ${res.type}`);
					await bot.send(`${arg.type}`);
				}
				// If this is your article, you can only comment in mode 3(->).
				// Also if you send too many in short period of time, system will force you to use mode 3.
				if (
					bot.line[22].str.includes("使用 → 加註方式") ||
					bot.line[23].str.includes(bot.state.username)
				) {
					// console.log(`${textToSend}`);
					await bot.send(`${t}${key.Enter}`);
					await bot.send(`y${key.Enter}`);
					console.log("after send ", bot.screen);
				} else {
					// not success
					return Promise.reject("comment failed");
				}
				// here, after sent comment, bot will be outside of article
				// thus we need to go back to article again.
				await bot.send(`${key.Enter}`);
				console.log("after enter ", bot.screen);
			}

			return Promise.resolve("comment success");
		} catch (err) {
			return Promise.reject(err);
		}
	}
}

export default Article;

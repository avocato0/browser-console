import { Protocol } from 'devtools-protocol';
import SourceMaps from './SourceMaps';
import { URL } from 'url';

export interface IPosition {
	line: number;
	column: number;
	source: string;
}

export interface IPreview {
	title: string;
	objectId?: Protocol.Runtime.RemoteObjectId;
	isNode: boolean;
}

export interface IDescriptor {
	enumerable?: boolean;
	configurable?: boolean;
	writable?: boolean;
	isOwn?: boolean;
}

interface IGetPropsResponse {
	preview: IPreview;
	name: string;
	descriptor: IDescriptor;
}

export default class Log {
	private sourceMaps = SourceMaps;

	type: Protocol.Runtime.ConsoleAPICalledEvent['type'];
	args: Protocol.Runtime.RemoteObject[];
	generatedPosition: IPosition;
	originalPosition: IPosition;

	constructor(
		logEvent: Protocol.Runtime.ConsoleAPICalledEvent,
		private getPropsByObjectId: (
			objectId: Protocol.Runtime.RemoteObjectId,
			isProperty?: boolean
		) => Promise<Protocol.Runtime.GetPropertiesResponse | undefined>
	) {
		const { type, args, stackTrace } = logEvent;

		if (!stackTrace?.callFrames?.length) {
			return;
		}

		this.type = type;
		this.args = args;

		const callFrame = stackTrace.callFrames[0];
		const { url, lineNumber, columnNumber } = callFrame;

		this.generatedPosition = {
			line: lineNumber,
			column: columnNumber,
			source: this.getPathFromURL(url),
		};

		const sourceMapPosition = this.sourceMaps.getOriginalPosition(url, {
			line: lineNumber + 1,
			column: columnNumber + 1,
		});

		this.originalPosition = {
			line: sourceMapPosition.line as number,
			column: sourceMapPosition.column as number,
			source: sourceMapPosition.source ? this.getPathFromURL(sourceMapPosition.source) : '',
		};
	}

	async getProps(object: IPreview): Promise<IGetPropsResponse[] | undefined> {
		if (object.objectId) {
			const response = await this.getPropsByObjectId(object.objectId);
			let nodeResult: Protocol.Runtime.PropertyDescriptor[] = [];

			if (response) {
				if (object.isNode) {
					const nodePropsResponse = await this.getPropsByObjectId(object.objectId, false);
					if (nodePropsResponse) {
						nodeResult = nodePropsResponse.result;
					}
				}

				const { result } = response;

				return result
					.concat(nodeResult)
					.filter(({ value }) => value)
					.map((propertyDescriptor) => {
						const {
							value,
							name,
							enumerable,
							configurable,
							writable,
							isOwn,
						} = propertyDescriptor;

						return {
							preview: this.getPreview(value as Protocol.Runtime.RemoteObject),
							name,
							descriptor: {
								enumerable,
								configurable,
								writable,
								isOwn,
							},
						};
					});
			}
		}
	}

	private getPathFromURL(url: string) {
		return new URL(url).pathname;
	}

	get existOnClient() {
		return Boolean(
			this.args.length && this.originalPosition.source && this.originalPosition.line
		);
	}

	private quoteString(isQuote: boolean, value: any) {
		return `${isQuote ? `'${value}'` : value}`;
	}

	private valueToString(arg: any) {
		return this.quoteString(typeof arg === 'string', arg);
	}

	private propToString(prop: Protocol.Runtime.PropertyPreview | undefined) {
		if (prop) {
			return this.quoteString(prop.type === 'string', prop.value);
		}
	}

	private objectToString(obj: Protocol.Runtime.ObjectPreview) {
		return this.quoteString(obj.type === 'string', obj.description);
	}

	private entryToString(entry: Protocol.Runtime.EntryPreview | undefined) {
		if (entry?.value) {
			if (entry.key) {
				return `${this.objectToString(entry.key)} => ${this.objectToString(entry.value)}`;
			}

			return this.objectToString(entry.value);
		}
	}

	getPreviewOfRemoteObject = (object: Protocol.Runtime.RemoteObject) => {
		const ignoreClasses = ['Object', 'Function'];
		const { type, value, subtype, preview, description, className } = object;
		const props = preview?.properties as Protocol.Runtime.PropertyPreview[];

		if (Object.hasOwnProperty.call(object, 'value')) {
			return this.valueToString(value);
		}

		const classDescription =
			className && !ignoreClasses.includes(className) ? `${className}: ` : '';

		switch (type) {
			case 'object':
				if (!subtype) {
					return `${classDescription}{${preview?.properties
						.map((prop) => `${prop.name}: ${this.propToString(prop)}`)
						.join(', ')}}`;
				}

				switch (subtype) {
					case 'array':
						return `[${preview?.properties.map(this.propToString, this).join(', ')}]`;

					case 'promise':
						return `${description}: {<${this.propToString(props[0])}>: ${this.propToString(
							props[1]
						)}}`;

					case 'map':
					case 'set':
					case 'weakmap':
					case 'weakset':
						return `${description}: {${preview?.entries
							?.map(this.entryToString, this)
							.join(', ')}}`;
				}
		}

		return `${classDescription}${description}`;
	};

	get preview() {
		return this.args.map(this.getPreview);
	}

	get previewTitle() {
		return this.preview.map((preview) => preview.title).join(', ');
	}

	getPreview = (remoteObject: Protocol.Runtime.RemoteObject): IPreview => {
		return {
			title: this.getPreviewOfRemoteObject(remoteObject),
			objectId: remoteObject.objectId,
			isNode: remoteObject.subtype === 'node',
		} as IPreview;
	};
}

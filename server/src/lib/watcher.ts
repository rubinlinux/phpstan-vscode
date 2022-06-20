import type { Disposable, _Connection } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { watcherNotification } from './notificationChannels';
import type { PHPStanCheckManager } from './phpstan/manager';
import { createDebouncer } from '../../../shared/util';
import { TextDocuments } from 'vscode-languageserver';
import { WhenToRun } from '../../../shared/config';
import { getConfiguration } from './config';
import { log } from './log';

export class Watcher implements Disposable {
	private _disposables: Disposable[] = [];
	private readonly _phpstan: PHPStanCheckManager;
	private readonly _debouncer = createDebouncer(1000);
	private readonly _connection: _Connection;
	private readonly _documents: TextDocuments<TextDocument>;

	public constructor({
		phpstan,
		connection,
	}: {
		phpstan: PHPStanCheckManager;
		connection: _Connection;
	}) {
		const documents: TextDocuments<TextDocument> = new TextDocuments(
			TextDocument
		);

		this._phpstan = phpstan;
		this._connection = connection;
		this._documents = documents;

		this._disposables.push(
			this._connection.onNotification(watcherNotification, (data) => {
				if (data.operation === 'watch') {
					void this._phpstan.checkFile(
						{
							getText: () => data.content,
							languageId: data.languageId,
							uri: data.uri,
						},
						data.dirty,
						true
					);
				}
			})
		);
	}

	private async _onDocumentSave(e: TextDocument): Promise<void> {
		await this._phpstan.checkFile(e, false, true);
	}

	private _onDocumentChange(e: TextDocument): void {
		this._debouncer.debounce(async () => {
			await this._phpstan.checkFile(e, true, true);
		});
	}

	private async _onDocumentClose(e: TextDocument): Promise<void> {
		await this._connection.sendDiagnostics({
			uri: e.uri,
			diagnostics: [],
		});
	}

	private _watch(current: WhenToRun): void {
		if (current === WhenToRun.NEVER) {
			return;
		}

		if (current === WhenToRun.ON_SAVE) {
			this._disposables.push(
				this._documents.onDidSave(async (e) => {
					await log(this._connection, 'Document saved, checking');
					void this._onDocumentSave(e.document);
				})
			);
		} else if (current === WhenToRun.CONTENT_CHANGE) {
			this._documents.onDidChangeContent(async (e) => {
				await log(this._connection, 'Document changed, checking');
				void this._onDocumentChange(e.document);
			});
		}

		if ([WhenToRun.CONTENT_CHANGE, WhenToRun.ON_SAVE].includes(current)) {
			this._disposables.push(
				this._documents.onDidChangeContent(async (e) => {
					await log(this._connection, 'Document opened, checking');
					void this._onDocumentSave(e.document);
				})
			);
		}

		this._disposables.push(
			this._documents.onDidClose((e) => {
				return this._onDocumentClose(e.document);
			})
		);

		this._disposables.push(
			this._connection.onDidChangeConfiguration(() => {
				void log(
					this._connection,
					'WhenToRun setting changed, re-registering handlers'
				);
				this.dispose();
				void this.watch();
			})
		);
	}

	public async watch(): Promise<void> {
		const config = await getConfiguration(this._connection);
		this._watch(config.phpstan.whenToRun);
		this._documents.listen(this._connection);
	}

	public dispose(): void {
		this._disposables.forEach((d) => void d.dispose());
		this._debouncer.dispose();
		this._disposables = [];
	}
}

import { Optional, Inject } from "@angular/core";
import { UploaderConfig, UploaderOptions, FileItem, FileType, FileLikeObject, FilterFunction } from './index';

export type ParsedResponseHeaders = { [headerFieldName: string]: string };

export class Uploader {
    private _options: UploaderOptions;
    private _queue: Array<FileItem> = [];
    private _progress: number = 0;
    private _isUploading: boolean = false;
    private _nextIndex: number = 0;
    private _failFilterIndex: number;

    get options(): UploaderOptions {
        return this._options;
    }

    get queue(): Array<FileItem> {
        return this._queue;
    }

    get progress(): number {
        return this._progress;
    }

    get isUploading(): boolean {
        return this._isUploading;
    }

    get notUploadedCount(): number {
        return this.getNotUploadedItems().length;
    }

    get uploadedCount(): number {
        return this._queue.filter((item: FileItem) => item.isUploaded).length;
    }

    getNextIndex(): number {
        return ++this._nextIndex;
    }

    constructor(options?: UploaderOptions,
        @Inject(UploaderConfig) @Optional() private globalConfig?: UploaderConfig) {

        this.setOptions(options);
    }

    /**
     * 重置选项
     * 
     * @param {UploaderOptions} options 
     * @param {boolean} [includeOldQueue=true] 是否包括已存在队列中的文件
     */
    setOptions(options: UploaderOptions, includeOldQueue: boolean = true) {
        this._options = Object.assign({
            filters: [],
            disableMultipart: false,
            method: 'POST',
            alias: 'file',
            withCredentials: true,
            auto: false,
            limit: -1,
            size: -1,
            removeAfterUpload: false
        }, this.globalConfig, this._options, options);

        // 数量
        if (this._options.limit !== -1)
            this._options.filters.unshift({ name: 'queueLimit', fn: this._queueLimitFilter });

        // 大小
        if (this._options.size !== -1)
            this._options.filters.unshift({ name: 'fileSize', fn: this._fileSizeFilter });

        // mime类型
        if (this._options.mimes)
            this._options.filters.unshift({ name: 'mimeType', fn: this._mimeTypeFilter });

        // 对已经存在的队列重置所有配置信息
        if (includeOldQueue) {
            for (let i = 0; i < this._queue.length; i++) {
                this._queue[i].setOptions(this._options)
            }
        }
    }

    private _queueLimitFilter(): boolean {
        return this._options.limit === undefined || this._queue.length < this._options.limit;
    }

    private _fileSizeFilter(item: FileLikeObject): boolean {
        return !(this._options.size && item.size > this._options.size);
    }

    private _mimeTypeFilter(item: FileLikeObject): boolean {
        return !(this._options.mimes && this._options.mimes.indexOf(item.type) === -1);
    }

    private _fileTypeFilter(item: FileLikeObject): boolean {
        return !(this._options.types && this._options.types.indexOf(FileType.getMimeClass(item)) === -1);
    }

    private _isValidFile(file: FileLikeObject, filters: FilterFunction[], options: UploaderOptions): boolean {
        this._failFilterIndex = -1;
        return !filters.length ? true : filters.every((filter: FilterFunction) => {
            this._failFilterIndex++;
            return filter.fn.call(this, file, options);
        });
    }

    /**
     * 过滤器，如果未指定采用内置
     */
    private _getFilters(filters: FilterFunction[] | string): FilterFunction[] {
        if (!filters) return this._options.filters;
        if (Array.isArray(filters)) return filters;
        if (typeof filters === 'string') {
            let names = filters.match(/[^\s,]+/g);
            return this._options.filters
                .filter((filter: any) => names.indexOf(filter.name) !== -1);
        }
        return this._options.filters;
    }

    private _getIndexOfItem(value: any): number {
        return typeof value === 'number' ? value : this._queue.indexOf(value);
    }

    private getNotUploadedItems(): Array<any> {
        return this._queue.filter((item: FileItem) => !item.isUploaded);
    }

    /**
     * 获取待上传文件
     */
    getReadyItems(): Array<any> {
        return this._queue
            .filter((item: FileItem) => (item.isReady && !item.isUploading))
            .sort((item1: any, item2: any) => item1.index - item2.index);
    }

    /**
     * 将文件放入队列中
     * 
     * @param {File[]} files 
     * @param {UploaderOptions} [options] 
     * @param {(FilterFunction[] | string)} [filters] 
     */
    addToQueue(files: File[], options?: UploaderOptions, filters?: FilterFunction[] | string) {
        let list: File[] = [];
        for (let file of files) list.push(file);
        let arrayOfFilters = this._getFilters(filters);
        let count = this._queue.length;
        let addedFileItems: FileItem[] = [];
        if (!options) {
            options = this._options;
        }
        list.map((some: File) => {
            let temp = new FileLikeObject(some);
            if (this._isValidFile(temp, arrayOfFilters, options)) {
                let fileItem = new FileItem(this, some, options);
                addedFileItems.push(fileItem);
                this._queue.push(fileItem);
                if (this._options.onFileQueued) this._options.onFileQueued(fileItem);
            } else {
                let filter = arrayOfFilters[this._failFilterIndex];
                if (this._options.onError) this._options.onError(temp, filter, options);
            }
        });
    }

    /**
     * 从队列中移除一个文件
     * 
     * @param {(FileItem | Number)} value FileItem对象或下标
     */
    removeFromQueue(value: FileItem | Number): void {
        let index = this._getIndexOfItem(value);
        let item = this._queue[index];
        if (item.isUploading) {
            item.cancel();
        }
        this._queue.splice(index, 1);
        this._progress = this._getTotalProgress();
        if (this._options.onFileDequeued) this._options.onFileDequeued(item);
    }

    clearQueue(): void {
        while (this._queue.length) {
            this._queue[0].remove();
        }
        this._progress = 0;
        if (this._options.onFileDequeued) this._options.onFileDequeued();
    }

    uploadItem(value: FileItem): void {
        let index = this._getIndexOfItem(value);
        let item = this._queue[index];
        item._prepareToUploading();
        if (this._isUploading) {
            return;
        }
        this._isUploading = true;
        this._xhrTransport(item);
    }

    cancelItem(value: FileItem): void {
        let index = this._getIndexOfItem(value);
        let item = this._queue[index];
        if (item && item.isUploading) {
            item._xhr.abort();
        }
    }

    uploadAll(): void {
        let items = this.getNotUploadedItems().filter((item: FileItem) => !item.isUploading);
        if (!items.length) {
            return;
        }
        items.map((item: FileItem) => item._prepareToUploading());

        if (this._options.onStart) this._options.onStart();
        items[0].upload();
    }

    cancelAll(): void {
        let items = this.getNotUploadedItems();
        items.map((item: FileItem) => item.cancel());

        if (this._options.onCancel) this._options.onCancel();
    }

    destroy(): void {
        return void 0;
    }

    private _xhrTransport(item: FileItem): any {
        item.onBeforeUpload();

        // 自实现
        if (item.options.uploadTransport) {
            item.options.uploadTransport.apply(this, [ item ]).subscribe((response: any) => {
                this._onSuccessItem(item, response, 0, null);
                this._onCompleteItem(item, response, 0, null);
            });
            return this;
        }

        let xhr = item._xhr = new XMLHttpRequest();
        let sendable: any;
        if (typeof item._file.size !== 'number') {
            throw new TypeError('The file specified is no longer valid');
        }
        if (!this._options.disableMultipart) {
            sendable = new FormData();

            sendable.append(item.options.alias, item._file, item.file.name);

            if (this._options.params !== undefined) {
                Object.keys(this._options.params).forEach((key: string) => {
                    sendable.append(key, this._options.params[key]);
                });
            }
        } else {
            sendable = item._file;
        }

        xhr.upload.onprogress = (event: any) => {
            let progress = Math.round(event.lengthComputable ? event.loaded * 100 / event.total : 0);
            this._onProgressItem(item, progress);
        };
        xhr.onload = () => {
            let headers = this._parseHeaders(xhr.getAllResponseHeaders());
            let response = this._transformResponse(xhr.response, headers);
            let gist = this._isSuccessCode(xhr.status) ? 'Success' : 'Error';
            let method = '_on' + gist + 'Item';
            (this as any)[method](item, response, xhr.status, headers);
            this._onCompleteItem(item, response, xhr.status, headers);
        };
        xhr.onerror = () => {
            let headers = this._parseHeaders(xhr.getAllResponseHeaders());
            let response = this._transformResponse(xhr.response, headers);
            this._onErrorItem(item, response, xhr.status, headers);
            this._onCompleteItem(item, response, xhr.status, headers);
        };
        xhr.onabort = () => {
            let headers = this._parseHeaders(xhr.getAllResponseHeaders());
            let response = this._transformResponse(xhr.response, headers);
            this._onCancelItem(item, response, xhr.status, headers);
            this._onCompleteItem(item, response, xhr.status, headers);
        };
        xhr.open(item.options.method, item.options.url, true);
        xhr.withCredentials = item.options.withCredentials;
        if (item.options.headers && item.options.headers.length > 0) {
            for (let header of item.options.headers) {
                xhr.setRequestHeader(header.name, header.value);
            }
        }
        xhr.send(sendable);
        return this;
    }

    private _getTotalProgress(value: number = 0): number {
        if (this._options.removeAfterUpload) {
            return value;
        }
        let notUploaded = this.getNotUploadedItems().length;
        let uploaded = notUploaded ? this._queue.length - notUploaded : this._queue.length;
        let ratio = 100 / this._queue.length;
        let current = value * ratio / 100;
        return Math.round(uploaded * ratio + current);
    }

    private _parseHeaders(headers: string): ParsedResponseHeaders {
        let parsed: any = {};
        let key: any;
        let val: any;
        let i: any;
        if (!headers) {
            return parsed;
        }
        headers.split('\n').map((line: any) => {
            i = line.indexOf(':');
            key = line.slice(0, i).trim().toLowerCase();
            val = line.slice(i + 1).trim();
            if (key) {
                parsed[key] = parsed[key] ? parsed[key] + ', ' + val : val;
            }
        });
        return parsed;
    }

    private _transformResponse(response: string, headers: ParsedResponseHeaders): string {
        return response;
    }

    private _isSuccessCode(status: number): boolean {
        return (status >= 200 && status < 300) || status === 304;
    }

    private _onProgressItem(item: FileItem, progress: any): void {
        let total = this._getTotalProgress(progress);
        this._progress = total;
        item.onProgress(progress);
    }

    _onErrorItem(item: FileItem, response: string, status: number, headers: ParsedResponseHeaders): void {
        item.onError(response, status, headers);
    }

    private _onSuccessItem(item: FileItem, response: string, status: number, headers: ParsedResponseHeaders): void {
        item.onSuccess(response, status, headers);
    }

    private _onCancelItem(item: FileItem, response: string, status: number, headers: ParsedResponseHeaders): void {
        item.onCancel(response, status, headers);
    }

    _onCompleteItem(item: FileItem, response: string, status: number, headers: ParsedResponseHeaders): void {
        item.onComplete(response, status, headers);
        let nextItem = this.getReadyItems()[0];
        this._isUploading = false;
        if (nextItem) {
            nextItem.upload();
            return;
        }
        this._progress = this._getTotalProgress();
        if (this._options.onFinished) this._options.onFinished();
    }
}
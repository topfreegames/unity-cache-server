const helpers = require('./../helpers');
const filesize = require('filesize');
const consts = require('./../constants');
const Duplex = require('stream').Duplex;

const kSource = Symbol("source");
const kCache = Symbol("cache");
const kSendFileQueue = Symbol("sendFileQueue");
const kReadStateVersion = Symbol("readStateVersion");
const kReadStateCommand = Symbol("readStateCommand");
const kReadStatePutStream = Symbol("readStatePutStream");

class CommandProcessor extends Duplex {

    /**
     *
     * @param {CacheBase} cache
     */
    constructor(cache) {
        super();
        this[kCache] = cache;
        this[kSendFileQueue] = [];
        this._readState = kReadStateVersion;

        /**
         *
         * @type {PutTransaction}
         * @private
         */
        this._trx = null;

        this._putStream = null;
        this._putSize = 0;
        this._putSent = 0;
        this._sendFileQueueChunkReads = 0;
        this._sendFileQueueReadDuration = 0;
        this._sendFileQueueReadBytes = 0;
        this._sendFileQueueCount = 0;
        this._sendFileQueueSentCount = 0;
        this._isReading = false;
        this._readReady = true;
        this._registerEventListeners();
    }

    _registerEventListeners() {
        const self = this;
        this.once('finish', this._printReadStats);
        this.on('pipe', src => {
            self[kSource] = src;
        });
    }

    // noinspection JSUnusedGlobalSymbols
    /**
     *
     * @param {Buffer} chunk
     * @param {String} encoding
     * @param {Function} callback
     * @private
     */
    _write(chunk, encoding, callback) {
        let handler = null;

        switch(this._readState) {
            case kReadStateVersion:
                handler = this._handleVersion(chunk);
                break;
            case kReadStateCommand:
                handler = this._handleCommand(chunk);
                break;
            case kReadStatePutStream:
                handler = this._handleWrite(chunk);
                break;
            default:
                return callback(null);
        }

        handler.then(() => callback(), err => this._quit(err));
    }

    /**
     * @private
     */
    _read() {
        this._readReady = true;
        Promise.resolve().then(() => this._read_internal());
    }

    /**
     * @private
     */
    _read_internal() {
        if(this._isReading || this[kSendFileQueue].length === 0)
            return;

        let self = this;
        let file = self[kSendFileQueue][0];

        self._readReady = self.push(file.header, 'ascii');

        if(!file.exists) {
            self[kSendFileQueue].shift();
            return;
        }

        self._isReading = true;
        self._readStartTime = Date.now();
        this[kCache].getFileStream(file.type, file.guid, file.hash)
            .then(stream => {
                function readChunk() {
                    if(!self._readReady) {
                        return setImmediate(readChunk);
                    }

                    let chunk;
                    while(chunk = stream.read()) {
                        self._readReady = self.push(chunk, 'ascii');
                        self._sendFileQueueChunkReads++;
                        self._sendFileQueueReadBytes += chunk.length;

                        if(!self._readReady) {
                            setImmediate(readChunk);
                            break;
                        }
                    }
                }

                stream.on('readable', readChunk);

                stream.on('end', () => {
                    self[kSendFileQueue].shift();
                    self._sendFileQueueSentCount++;
                    self._isReading = false;
                    self._sendFileQueueReadDuration += Date.now() - self._readStartTime;
                    self._read();
                })
            })
            .catch(err => {
                helpers.log(consts.LOG_ERR, err);
                self._isReading = false;
            });
    }

    /**
     * @private
     */
    _printReadStats() {
        if(this._sendFileQueueReadDuration > 0) {
            let totalTime = this._sendFileQueueReadDuration / 1000;
            let throughput = (this._sendFileQueueReadBytes / totalTime).toFixed(2);
            helpers.log(consts.LOG_INFO, `Sent ${this._sendFileQueueSentCount} of ${this._sendFileQueueCount} requested files (${this._sendFileQueueChunkReads} chunks) totaling ${filesize(this._sendFileQueueReadBytes)} in ${totalTime} seconds (${filesize(throughput)}/sec)`);
        }
    }

    /**
     *
     * @param {Error?} err
     * @private
     */
   _quit(err) {
       return new Promise(resolve => {
           this[kSource].unpipe(this);
           this[kSource].emit('quit');
           this._readState = null;
           if(err) {
               helpers.log(consts.LOG_ERR, err);
           }

           resolve();
       });
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    _handleVersion(data) {
        const self = this;
        return new Promise((resolve, reject) => {
            let version = helpers.readUInt32(data);
            self._readState = kReadStateCommand;
            let err = null;
            if(version !== consts.PROTOCOL_VERSION) {
                version = 0;
                err = new Error("Bad Client protocol version");
            }

            self.push(helpers.encodeInt32(version));
            err ? reject(err) : resolve();
        });
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    _handleWrite(data) {
        const self = this;
        return new Promise(resolve => {
            this._putStream.write(data, 'ascii', () => {
                self._putSent += data.length;
                if(self._putSent === self._putSize) {
                    self._putStream.end();
                    self._readState = kReadStateCommand;
                    self._putSent = 0;
                    self._putSize = 0;
                }

                resolve();
            });
        });
    }

    /**
     *
     * @param {Buffer} data
     * @private
     */
    async _handleCommand(data) {
        let cmd, size, type, guid, hash = null;
        if(data.length > 1) {
            cmd = data.slice(0, 2).toString('ascii');
            type = cmd[1];

            if (data.length === 2 + consts.ID_SIZE) {
                guid = Buffer.from(data.slice(2, 2 + consts.GUID_SIZE));
                hash = Buffer.from(data.slice(2 + consts.HASH_SIZE));
            }
            else if (data.length === 2 + consts.SIZE_SIZE) {
                size = helpers.readUInt64(data.slice(2));
            }
        }
        else {
            cmd = data.toString('ascii');
        }

        switch(cmd) {
            case 'q':
                await this._quit();
                break;
            case 'ga':
            case 'gi':
            case 'gr':
                await this._onGet(type, guid, hash);
                break;
            case 'ts':
                await this._onTransactionStart(guid, hash);
                break;
            case 'te':
                await this._onTransactionEnd();
                break;
            case 'pa':
            case 'pi':
            case 'pr':
                await this._onPut(type, size);
                break;
            default:
                throw new Error(`Unrecognized command '${cmd}'`);
        }
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<void>}
     * @private
     */
    async _onGet(type, guid, hash) {

        try {
            const info = await this[kCache].getFileInfo(type, guid, hash);
            const resp = Buffer.from(`+${type}${helpers.encodeInt64(info.size)}`, 'ascii');
            this[kSendFileQueue].push({
                exists: true,
                header: Buffer.concat([resp, guid, hash], 50),
                size: info.size,
                type: type,
                guid: guid,
                hash: hash
            });

            this._sendFileQueueCount++;
            helpers.log(consts.LOG_DBG, `Adding file to send queue, size ${info.size}`);
        }
        catch(err) {
            const resp = Buffer.from(`-${type}`, 'ascii');
            this[kSendFileQueue].push({
                exists: false,
                header: Buffer.concat([resp, guid, hash], 34)
            });
        }
        finally {
            if(this[kSendFileQueue].length === 1) {
                this._read(this._readState.highWaterMark);
            }
        }
    }

    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {Promise<void>}
     * @private
     */
    async _onTransactionStart(guid, hash) {
        if(this._trx !== null) {
            helpers.log(consts.LOG_DBG, "Cancel previous transaction");
            this._trx = null;
        }

        this._trx = await this[kCache].createPutTransaction(guid, hash);
        helpers.log(consts.LOG_DBG, `Start transaction for GUID: ${helpers.GUIDBufferToString(guid)} Hash: ${hash.toString('hex')}`);
    }

    /**
     *
     * @returns {Promise<void>}
     * @private
     */
    async _onTransactionEnd() {
        if(!this._trx) {
            throw new Error("Invalid transaction isolation");
        }

        await this[kCache].endPutTransaction(this._trx);
        this.emit('onTransactionEnd', this._trx);
        helpers.log(consts.LOG_DBG, `End transaction for GUID: ${helpers.GUIDBufferToString(this._trx.guid)} Hash: ${this._trx.hash.toString('hex')}`);
        this._trx = null;
    }

    /**
     *
     * @param {String} type
     * @param {Number} size
     * @returns {Promise<void>}
     * @private
     */
    async _onPut(type, size) {
        if(!this._trx) {
            throw new Error("Not in a transaction");
        }

        this._putStream = await this._trx.getWriteStream(type, size);
        this._putSize = size;
        this._readState = kReadStatePutStream;
    }
}

module.exports = CommandProcessor;
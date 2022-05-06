'use strict';

var http = require('http'),
    https = require('https'),
    querystring = require('querystring'),
    crypto = require('crypto'),
    FormData = require('form-data');

var async = require('async');
var url = require('url');

/**
 * @typedef {object} ListFilesOptions
 * @property {number} [min]
 * @property {number} [max]
 */

/**
 * @typedef {{
 *     list: (
 *         options: ListFilesOptions,
 *         callback: Callback<{ results: never[]; next?: string }>
 *     ) => void;
 * }} ListCursorHandle
 */

/**
 * @typedef {object} UserOptions
 * @property {boolean} [ssl]
 * @property {string} [filename]
 * @property {string} [contentType]
 * @property {number} [knownLength]
 * @property {boolean} [store]
 * @property {boolean} [waitUntilReady]
 */

/**
 * @typedef {object} RequestOptions
 * @property {FormData | { [key: string]: unknown } | unknown[]} [data]
 * @property {boolean} [form]
 */

/**
 * @template [R1={ [key: string]: unknown; }] Default is `{ [key: string]: unknown; }`
 * @template [R2={ [key: string]: unknown; }] Default is `{ [key: string]: unknown; }`
 * @typedef {(
 *     err: Error | null | undefined,
 *     result1?: R1,
 *     result2?: R2
 * ) => void} Callback
 */

/**
 * @template {{ [key: string]: unknown }} S
 * @template {{ [key: string]: unknown }} D
 * @param {S} obj1
 * @param {D} obj2
 * @returns {S & D}
 */
function mergeObjects(obj1, obj2) {
    /** @type {{ [key: string]: unknown }} */
    var result = {};
    var attrname;

    for (attrname in obj1) {
        result[attrname] = obj1[attrname];
    }
    for (attrname in obj2) {
        result[attrname] = obj2[attrname];
    }

    return /** @type {S & D} */ (result);
}

/**
 * @param {http.IncomingMessage} res
 * @param {Callback<{ [key: string]: never }>} callback
 * @returns
 */
function setup_response_handler(res, callback) {
    if (typeof callback !== 'function') {
        return;
    }
    var responseString = '';
    /** @type {{ [key: string]: never }} */
    var resonseObject;
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
        responseString += chunk;
    });
    res.on('end', function () {
        var err;

        if (res.statusCode && res.statusCode > 201) {
            err = new Error(
                'Unexpected status ' + res.statusCode + ' from uploadcare.com'
            );
        }

        try {
            /** @type {{ [key: string]: never }} */
            resonseObject = JSON.parse(responseString);
        } catch (e) {
            callback(new Error('Invalid JSON from uploadcare.com'));
            return;
        }

        if (err) {
            callback(err, resonseObject);
        } else {
            callback(err, resonseObject);
        }
    });
}

/**
 * @class ListCursor
 * @param {ListCursorHandle} handle
 * @param {ListFilesOptions} options
 */
function ListCursor(handle, options) {
    /** @type {ListCursorHandle} */
    this.handle = handle;
    /** @type {ListFilesOptions} */
    this.options = options || {};
    /** @type {unknown[]} */
    this.results = [];
}

/**
 * @param {Callback<boolean>} callback
 * @name ListCursor#next
 */
ListCursor.prototype.next = function (callback) {
    this.handle.list(
        this.options,
        /**
         * @type {Callback<{ [key: string]: any }>}
         * @this ListCursor
         */
        function (err, result) {
            if (result && typeof result === 'object' && result.results) {
                this.results = result.results;
                if (typeof result.next === 'string') {
                    var parsed = url.parse(result.next, true);
                    this.options = mergeObjects(this.options, parsed.query);
                    callback(null, true);
                } else {
                    callback(null, false);
                }
            } else {
                this.results = [];
                callback(err, false);
            }
        }.bind(this)
    );
};

/** @type {UserOptions} */
var defaultOptions = {
    ssl: true
};

/**
 * @param {string} public_key
 * @param {string} private_key
 * @param {UserOptions} [baseOptions]
 */
module.exports = function (public_key, private_key, baseOptions) {
    var globalOptions = mergeObjects(defaultOptions, baseOptions || {});

    if (!globalOptions.ssl) {
        console.warn('HTTP requests won\'t be supported soon. Please enable the `ssl` option.');
    }

    /**
     * @param {string} method
     * @param {string} path
     * @param {RequestOptions & UserOptions} options
     * @param {Callback} callback
     */
    function _request(method, path, options, callback) {
        var request_data = '';
        if (options.data) {
            request_data = JSON.stringify(options.data);
        }

        //Prepare headers
        var content_type = 'application/json',
            //Hash private key
            content_hash = crypto
                .createHash('md5')
                .update(request_data)
                .digest('hex'),
            date = new Date().toUTCString(),
            sign_string = [method, content_hash, content_type, date, path].join(
                '\n'
            ),
            sign = crypto
                .createHmac('sha1', private_key)
                .update(sign_string)
                .digest('hex'),
            request_options = {
                host: 'api.uploadcare.com',
                port: options.ssl ? 443 : 80,
                path: path,
                method: method,
                headers: {
                    'Authentication': 'UploadCare ' + public_key + ':' + sign,
                    'X-Uploadcare-Date': date,
                    'Content-Type': content_type,
                    'Content-Length': request_data.length
                }
            };

        var req = options.ssl
            ? https.request(request_options)
            : http.request(request_options);

        req.on('response', function (res) {
            setup_response_handler(res, callback);
        });

        req.write(request_data);
        req.end();
    }
    /**
     * @param {string} path
     * @param {FormData} form
     * @param {Callback} callback
     */
    function _submit(path, form, callback) {
        form.submit(
            {
                host: 'upload.uploadcare.com',
                port: '443',
                path: path,
                protocol: 'https:'
            },
            function (err, res) {
                if (err) {
                    callback(err);
                } else {
                    setup_response_handler(res, callback);
                }
            }
        );
    }

    /**
     * @param {string} path
     * @param {RequestOptions & UserOptions} options
     * @param {Callback} callback
     */
    function post(path, options, callback) {
        if (options.form && options.data) {
            _submit(path, /** @type {FormData} */ (options.data), callback);
        } else {
            _request('POST', path, options, callback);
        }
    }
    /**
     * @param {string} path
     * @param {RequestOptions & UserOptions} options
     * @param {Callback} callback
     */
    function put(path, options, callback) {
        _request('PUT', path, options, callback);
    }

    /**
     * @param {string} path
     * @param {RequestOptions & UserOptions} options
     * @param {Callback} callback
     */
    function get(path, options, callback) {
        _request('GET', path, options, callback);
    }

    /**
     * This is a special case when uploading image from URL you have to check
     * status until you receive a success
     *
     * @param {string} token
     * @param {Callback} callback
     */
    function upload_fromurl_get_status(token, callback) {
        var path = '/from_url/status/?token=' + token + '&_=' + Date.now();
        https.get('https://upload.uploadcare.com' + path, function (res) {
            setup_response_handler(res, callback);
        });
    }
    /**
     * @param {string} path
     * @param {RequestOptions & UserOptions} options
     * @param {Callback} callback
     */
    function remove(path, options, callback) {
        _request('DELETE', path, options, callback);
    }

    var api = {
        file: {
            /**
             * @param {any} fileStream
             * @param {UserOptions | Callback} options
             * @param {Callback} [callback]
             */
            upload: function (fileStream, options, callback) {
                if (typeof options === 'function') {
                    callback = options;
                    options = globalOptions;
                }
                options = mergeObjects(globalOptions, options || {});
                /** @type {FormData.AppendOptions} */
                var file = {};
                if (options.filename) file.filename = options.filename;
                if (options.contentType) file.contentType = options.contentType;
                if (options.knownLength) file.knownLength = options.knownLength;
                var form = new FormData();
                form.append('UPLOADCARE_PUB_KEY', public_key);

                if (options.store === false) {
                    form.append('UPLOADCARE_STORE', 0);
                } else if (options.store === true) {
                    form.append('UPLOADCARE_STORE', 1);
                } else {
                    form.append('UPLOADCARE_STORE', 'auto');
                }
                form.append('file', fileStream, file);

                post(
                    '/base/',
                    mergeObjects(options, {
                        data: form,
                        form: true
                    }),
                    /** @type {Callback} */ (callback)
                );
            },
            /**
             * @param {string} fileUrl
             * @param {UserOptions} options
             * @param {Callback} callback
             */
            fromUrl: function (fileUrl, options, callback) {
                if (typeof options === 'function') {
                    callback = options;
                    options = globalOptions;
                }
                options = mergeObjects(globalOptions, options || {});
                // prepend 'http:' when url is simply starting by '//'
                if (fileUrl.indexOf('//') === 0) {
                    fileUrl = 'http:' + fileUrl;
                }
                var form = new FormData();
                if (options.store === false) {
                    form.append('store', 0);
                } else if (options.store === true) {
                    form.append('store', 1);
                } else {
                    form.append('store', 'auto');
                }
                form.append('pub_key', public_key);
                form.append('source_url', fileUrl);
                //filename
                post(
                    '/from_url/',
                    mergeObjects(options, {
                        data: form,
                        form: true
                    }),
                    function (err, res) {
                        if (err) {
                            return callback(err);
                        }
                        /**
                         * @typedef {object} Response
                         * @property {string} token
                         */
                        //
                        // we get a token, just wait for file UUID
                        function tick() {
                            upload_fromurl_get_status(
                                /** @type {Response} */ (res).token,
                                function (err, file) {
                                    if (err) {
                                        callback(err);
                                        return;
                                    }
                                    /**
                                     * @typedef {object} File
                                     * @property {string} status
                                     * @property {Error} error
                                     * @property {boolean} is_ready
                                     */
                                    if (
                                        /** @type {File} */ (file).status ===
                                        'error'
                                    ) {
                                        callback(
                                            /** @type {File} */ (file).error,
                                            file
                                        );
                                        return;
                                    }
                                    if (
                                        /** @type {File} */ (file).status ===
                                        'success'
                                    ) {
                                        if (options.waitUntilReady) {
                                            if (
                                                /** @type {File} */ (file)
                                                    .is_ready
                                            ) {
                                                callback(err, file);
                                                return;
                                            }
                                        } else {
                                            callback(err, file);
                                            return;
                                        }
                                    }
                                    setTimeout(tick, 100);
                                }
                            );
                        }
                        setTimeout(tick, 100);
                    }
                );
            }
        },
        files: {
            /**
             * @param {ListFilesOptions} options
             * @param {Callback} callback
             */
            list: function (options, callback) {
                var qs = querystring.stringify(options);
                get('/files/' + (qs ? '?' + qs : ''), globalOptions, callback);
            },
            /**
             * @param {string} fileId
             * @param {Callback} callback
             */
            store: function (fileId, callback) {
                post('/files/' + fileId + '/storage/', globalOptions, callback);
            },
            /**
             * @param {string} fileId
             * @param {string} target
             * @param {Callback} callback
             */
            storeCustom: function (fileId, target, callback) {
                post(
                    '/files/',
                    mergeObjects(globalOptions, {
                        data: { source: fileId, target: target }
                    }),
                    callback
                );
            },
            /**
             * @param {string} fileId
             * @param {Callback} callback
             */
            info: function (fileId, callback) {
                get('/files/' + fileId + '/', globalOptions, callback);
            },
            /**
             * @param {string} fileId
             * @param {Callback} callback
             */
            remove: function (fileId, callback) {
                remove('/files/' + fileId + '/', globalOptions, callback);
            },
            /**
             * @param {string[]} fileIds
             * @param {Callback} callback
             */
            removeMultiple: function (fileIds, callback) {
                _request(
                    'DELETE',
                    '/files/storage/',
                    mergeObjects(globalOptions, { data: fileIds }),
                    callback
                );
            },
            /**
             * @param {ListFilesOptions} options
             * @this {ListCursorHandle}
             */
            cursor: function (options) {
                return new ListCursor(this, options || {});
            },
            /**
             * @param {(
             *     results: unknown[],
             *     callback: async.ErrorCallback<Error> | null
             * ) => void} iteratorFn
             * @param {async.ErrorCallback<Error> | null} doneFn
             * @param {ListFilesOptions} options
             */
            iterate: function (iteratorFn, doneFn, options) {
                if (typeof doneFn === 'object') (doneFn = null), (options = {});
                options = mergeObjects({}, options);
                var maxLimit =
                    typeof options.max === 'number' ? options.max : -1;
                var cursor = this.cursor(options);
                var count = 0;
                doneFn = /** @type {async.ErrorCallback<Error>} */ (doneFn);
                async.during(
                    function (next) {
                        if (cursor.results) count += cursor.results.length;
                        if (maxLimit > -1 && count >= maxLimit) {
                            next(null, false);
                        } else {
                            cursor.next(next);
                        }
                    },
                    function (done) {
                        iteratorFn(cursor.results || [], done);
                    },
                    doneFn
                );
            }
        },
        group: {
            /**
             * @param {never[]} files
             * @param {RequestOptions & UserOptions} options
             * @param {Callback} callback
             */
            fromFiles: function (files, options, callback) {
                if (typeof options === 'function') {
                    callback = options;
                    options = globalOptions;
                }
                options = mergeObjects(globalOptions, options || {});
                var form = new FormData();
                form.append('pub_key', public_key);
                for (var i = 0; i < files.length; i++) {
                    form.append('files[' + i + ']', files[i]);
                }
                post(
                    '/group/',
                    mergeObjects(options, {
                        data: form,
                        ssl: true,
                        form: true
                    }),
                    callback
                );
            }
        },
        groups: {
            /**
             * @param {ListFilesOptions} options
             * @param {Callback} callback
             */
            list: function (options, callback) {
                var qs = querystring.stringify(options);
                get('/groups/' + (qs ? '?' + qs : ''), globalOptions, callback);
            },
            /**
             * @param {string} groupId
             * @param {Callback} callback
             */
            info: function (groupId, callback) {
                get('/groups/' + groupId + '/', globalOptions, callback);
            },
            /**
             * @param {string} groupId
             * @param {Callback} callback
             */
            store: function (groupId, callback) {
                put(
                    '/groups/' + groupId + '/storage/',
                    globalOptions,
                    callback
                );
            },
            /**
             * @param {string} groupId
             * @param {Callback} callback
             */
            remove: function (groupId, callback) {
                this.info(groupId, function (err, info) {
                    if (!err && (!info || !info.files)) {
                        err = new Error('Unexpected error');
                    }
                    if (err) return callback(err);
                    /** @typedef {{ files: { uuid: string }[] }} Response */
                    var fileIds = [];
                    for (
                        var i = 0;
                        i < /** @type {Response} */ (info).files.length;
                        i++
                    ) {
                        if (
                            typeof (/** @type {Response} */ (info).files[i]) ===
                                'object' &&
                            /** @type {Response} */ (info).files[i].uuid
                        ) {
                            fileIds.push(
                                /** @type {Response} */ (info).files[i].uuid
                            );
                        }
                    }
                    _request(
                        'DELETE',
                        '/files/storage/',
                        mergeObjects(globalOptions, { data: fileIds }),
                        function (err, res) {
                            callback(err, info, res);
                        }
                    );
                });
            }
        }
    };
    return api;
};

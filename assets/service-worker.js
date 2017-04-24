'use strict';
/**
 * @file
 * Сервис-воркер, обеспечивающий оффлайновую работу избранного
 */

const CACHE_VERSION = '1.0.0';

importScripts('../vendor/kv-keeper.js-1.0.4/kv-keeper.js');

// при установки СВ ждем кеширования нужных элементов
// потом активируем СВ не ждам деативации прежних версий
self.addEventListener('install', event => {
    const promise = preCacheAllFavorites()
        // Вопрос №1: зачем нужен этот вызов?
        .then(() => self.skipWaiting())
        .then(() => console.log('[ServiceWorker] Installed!'));

    event.waitUntil(promise);
});

// в цикле активации удаляем ненужный кеш и добавляем неконтролированных клиентов в scope СВ
self.addEventListener('activate', event => {
    const promise = deleteObsoleteCaches()
        .then(() => {
            // Вопрос №2: зачем нужен этот вызов?
            self.clients.claim();

            console.log('[ServiceWorker] Activated!');
        });

    event.waitUntil(promise);
});


self.addEventListener('fetch', event => {
    // берем URL запросв
    const url = new URL(event.request.url);

    // Вопрос №3: для всех ли случаев подойдёт такое построение ключа?
    const cacheKey = url.origin + url.pathname;

    let response;
    // если нужно кешировать данные этого запроса с данного URL
    if (needStoreForOffline(cacheKey)) {
        // если есть подходяший кеш в браузере, отвечаем кешом на запрос
        response = caches.match(cacheKey)
            // если нету кеша для данного URL
            // показываем эту страницу пользователью и слхраняем в кеш
            .then(cacheResponse => cacheResponse || fetchAndPutToCache(cacheKey, event.request));
    } else {
        // в другом случае отправляем данные с кеша
        response = fetchWithFallbackToCache(event.request);
    }

    event.respondWith(response);
});

self.addEventListener('message', event => {
    const promise = handleMessage(event.data);

    event.waitUntil(promise);
});


// Положить в новый кеш все добавленные в избранное картинки
function preCacheAllFavorites() {
    return getAllFavorites()
        .then(urls => Promise.all(
            urls.map(url => fetch(url)))
        )
        .then(responses => {
            return caches.open(CACHE_VERSION)
                .then(cache => {
                    return Promise.all(
                        responses.map(response => cache.put(response.url, response))
                    );
                });
        });
}

// Извлечь из БД добавленные в избранное картинки
function getAllFavorites() {
    return new Promise((resolve, reject) => {
        KvKeeper.getKeys((err, keys) => {
            // в случае ошибки при взятии ключей, переходить на reject промиса
            if (err) {
                return reject(err);
            }

            // получаем id избранных гифок
            const ids = keys
                // выбираем все id у которых есть префикс favorites:
                .filter(key => key.startsWith('favorites:'))
                // 'favorites:'.length == 10
                // убираем слово "favorites:" и получаем id всех избранных гифок
                .map(key => key.slice(10));

            // Promise будет ждать окончания всех внутренних промисов
            Promise.all(ids.map(getFavoriteById))
                .then(urlGroups => {
                    // id всех избранных гифок добавляется в один массив
                    // и этот массив дается при вызове функции getAllFavorites
                    return urlGroups.reduce((res, urls) => res.concat(urls), []);
                })
                .then(resolve, reject);
        });
    });
}

// Извлечь из БД запись о картинке
function getFavoriteById(id) {
    return new Promise((resolve, reject) => {
        KvKeeper.getItem('favorites:' + id, (err, val) => {
            if (err) {
                return reject(err);
            }

            const data = JSON.parse(val);
            const images = [data.fallback].concat(data.sources.map(item => item.url));

            resolve(images);
        });
    });
}

// Удалить неактуальный кеш
function deleteObsoleteCaches() {
    return caches.keys()
        .then(names => {
            // Вопрос №4: зачем нужна эта цепочка вызовов?
            return Promise.all(
                names.filter(name => name !== CACHE_VERSION)
                    .map(name => {
                        console.log('[ServiceWorker] Deleting obsolete cache:', name);
                        return caches.delete(name);
                    })
            );
        });
}

// Нужно ли при скачивании сохранять ресурс для оффлайна?
function needStoreForOffline(cacheKey) {
    return cacheKey.includes('/vendor/') ||
        cacheKey.includes('/assets/') ||
        cacheKey.endsWith('/jquery.min.js');
}

// Скачать и добавить в кеш
function fetchAndPutToCache(cacheKey, request) {
    return fetch(request)
        .then(response => {
            return caches.open(CACHE_VERSION)
                .then(cache => {
                    // Вопрос №5: для чего нужно клонирование?
                    cache.put(cacheKey, response.clone());
                })
                .then(() => response);
        })
        .catch(err => {
            console.error('[ServiceWorker] Fetch error:', err);
            return caches.match(cacheKey);
        });
}

// Попытаться скачать, при неудаче обратиться в кеш
function fetchWithFallbackToCache(request) {
    return fetch(request)
        .catch(() => {
            console.log('[ServiceWorker] Fallback to offline cache:', request.url);
            return caches.match(request.url);
        });
}

// Обработать сообщение от клиента
const messageHandlers = {
    'favorite:add': handleFavoriteAdd
};

function handleMessage(eventData) {
    const message = eventData.message;
    const id = eventData.id;
    const data = eventData.data;

    console.log('[ServiceWorker] Got message:', message, 'for id:', id);

    const handler = messageHandlers[message];
    return Promise.resolve(handler && handler(id, data));
}

// Обработать сообщение о добавлении новой картинки в избранное
function handleFavoriteAdd(id, data) {
    return caches.open(CACHE_VERSION)
        .then(cache => {
            const urls = [].concat(
                data.fallback,
                (data.sources || []).map(item => item.url)
            );

            return Promise
                .all(urls.map(url => fetch(url)))
                .then(responses => {
                    return Promise.all(
                        responses.map(response => cache.put(response.url, response))
                    );
                });
        });
}

import Storage from '../storage/storage'

let permit = {}

// Получить аккаунт
Object.defineProperty(permit, 'account', { 
    get: ()=> Storage.get('account', '{}')
})

// Получить данные пользователя
Object.defineProperty(permit, 'user', { 
    get: ()=> Storage.get('account_user', '{}')
})

// Получить токен аккаунта
Object.defineProperty(permit, 'token', { 
    get: ()=> permit.account.token
})

// Пользователь залогинен и разрешено использование аккаунта
Object.defineProperty(permit, 'access', { 
    get: ()=> permit.token && window.lampa_settings.account_use
})

// Пользователь включил синхронизацию
Object.defineProperty(permit, 'use', { 
    get: ()=>  permit.access && Storage.field('account_use')
})

// Синхронизация включена и разрешено использование синхронизации
Object.defineProperty(permit, 'sync', { 
    get: ()=>  permit.use && window.lampa_settings.account_sync
})

export default permit
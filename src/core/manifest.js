let object = {
    author: 'Yumata',
    github: 'https://github.com/yumata/lampa-source',
    github_lampa: 'https://yumata.github.io/lampa/',
    css_version: '2.7.1',
    app_version: '2.4.6',
    cub_site: 'cub.rip'
}

let plugins = []

Object.defineProperty(object, 'app_digital', { get: ()=> parseInt(object.app_version.replace(/\./g,'')) })
Object.defineProperty(object, 'css_digital', { get: ()=> parseInt(object.css_version.replace(/\./g,'')) })

Object.defineProperty(object, 'plugins', { 
    get: ()=> plugins,
    set: (plugin)=> {
        if(typeof plugin == 'object' && typeof plugin.type == 'string'){
            plugins.push(plugin)
        }
    }
})

/**
 * Старые зеркала, которые не используются больше, но могут быть полезны для обратной совместимости
 */
Object.defineProperty(object, 'old_mirrors', { 
    get: ()=> ['cub.red', 'standby.cub.red', 'kurwa-bober.ninja', 'nackhui.com'],
    set: ()=> {}
})

/**
 * Список актуальных зеркал
 */
Object.defineProperty(object, 'cub_mirrors', { 
    get: ()=> {
        let lampa = ['cub.red', 'durex.monster', 'cubnotrip.top']
        let users = localStorage.getItem('cub_mirrors') || '[]'

        try {
            users = JSON.parse(users)
        } catch (e) {
            users = []
        }

        if(Object.prototype.toString.call( users ) === '[object Array]' && users.length){
            return lampa.concat(users)
        }

        return lampa
    },
    set: ()=> {}
})

/**
 * Список зеркал для сокета, вынесены отдельно, так как могут отличаться от обычных зеркал
 */
Object.defineProperty(object, 'soc_mirrors', { 
    get: ()=> ['cub.red', 'kurwa-bober.ninja', 'nackhui.com'],
    set: ()=> {}
})

/**
 * Текущее доменное имя, которое используется для работы с CUB
 */
Object.defineProperty(object, 'cub_domain', { 
    get: ()=> {
        let use = localStorage.getItem('cub_domain') || ''

        return object.cub_mirrors.indexOf(use) > -1 ? use : object.cub_mirrors[0]
    } 
})

/**
 * Ссылка на сайт CUB
 */
Object.defineProperty(object, 'qr_site', { 
    get: ()=> {
        return object.cub_domain+'/img/other/qr-code-strong.png'
    } 
})

/**
 * Ссылка на QR для добавления устройства
 */
Object.defineProperty(object, 'qr_device_add', { 
    get: ()=> {
        return object.cub_domain+'/img/other/qr-add-device.png'
    } 
})

export default object
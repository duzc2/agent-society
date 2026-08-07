import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Dialog from 'primevue/dialog'
import Tooltip from 'primevue/tooltip'
import DialogService from 'primevue/dialogservice'
import ConfirmationService from 'primevue/confirmationservice'
import ToastService from 'primevue/toastservice'
import { MyPreset } from './assets/theme/preset'
import './style.css'
import App from './App.vue'

/**
 * 修复 PrimeVue Dialog 的 initDrag 在 Transition 期间的错误。
 *
 * 根因：关闭弹窗后 ~300ms 内，CSS 渐隐过渡（name="p-dialog"）还在进行，
 * header DOM 元素仍存在且绑有 mousedown 事件。若用户在此窗口期内快速连续点击
 * 同一位置，mousedown 会击中正在淡出的 header，而 Vue 已通过 v-if="visible"
 * 将 container 设为 null，导致 this.container.style.margin 崩溃。
 *
 * 修复：initDrag 执行前检查 visible 和 container 是否存在。
 */
const _origInitDrag = (Dialog as any).methods.initDrag
;(Dialog as any).methods.initDrag = function (event: MouseEvent) {
  if (!this.visible || !this.container) return
  return _origInitDrag.call(this, event)
}

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(PrimeVue, {
    theme: {
        preset: MyPreset,
        options: {
            darkModeSelector: '.my-app-dark',
        }
    }
})
app.use(DialogService)
app.use(ConfirmationService)
app.use(ToastService)
app.directive('tooltip', Tooltip)

app.mount('#app')

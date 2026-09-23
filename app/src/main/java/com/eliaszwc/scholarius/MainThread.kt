package com.eliaszwc.scholarius

import android.os.Handler
import android.os.Looper

/**
 * 把回调切回主线程。
 *
 * 登录与更新的流程都跑在后台线程（网络 IO），但回调要落到主线程上
 * —— 因为最终都要去调 WebView 的 `evaluateJavascript`，那必须在主线程。
 */
object MainThread {

    private val handler = Handler(Looper.getMainLooper())

    fun post(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action()
        } else {
            handler.post(action)
        }
    }
}

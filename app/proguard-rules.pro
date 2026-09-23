# 默认不混淆。若将来开启 minify，这里补 keep 规则。
# WebView 通过 addJavascriptInterface 暴露的桥对象必须保留方法名，
# 否则网页端调用会被混淆掉。

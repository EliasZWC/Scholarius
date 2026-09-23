plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// 版本号：唯一来源。只有明确要求发版时才修改这两个值。
// versionCode 每次发版 +1；versionName 必须与 Git 标签 vX.Y.Z 中的 X.Y.Z 一致。
// ---------------------------------------------------------------------------
val appVersionCode = 7
val appVersionName = "0.0.7"

// 可选：从环境变量读取发布签名（由 GitHub Actions 注入）。
// 未配置时回退到 debug 签名，保证工作流始终能产出可安装的 APK。
val envKeystoreFile: String? = System.getenv("KEYSTORE_FILE")
val envKeystorePassword: String? = System.getenv("KEYSTORE_PASSWORD")
val envKeyAlias: String? = System.getenv("KEY_ALIAS")
val envKeyPassword: String? = System.getenv("KEY_PASSWORD")
val hasReleaseKeystore: Boolean = listOf(envKeystoreFile, envKeystorePassword, envKeyAlias, envKeyPassword)
    .all { !it.isNullOrBlank() }

android {
    namespace = "com.eliaszwc.scholarius"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.eliaszwc.scholarius"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        /*
           GitHub OAuth App 的 client_id（Device Flow 用）。

           它**不是密钥**，明文写在 APK 里是 Device Flow 的设计允许的
           —— 这正是选 Device Flow 而非常规 OAuth 的原因：纯客户端 app
           无法安全保存 client_secret，所以干脆不用 secret。

           值放在 gradle.properties（GITHUB_CLIENT_ID），改的时候不用动这个文件。
           注册路径：GitHub → Settings → Developer settings → OAuth Apps
           注意不要用旁边的 GitHub Apps —— 那个不支持 Device Flow。
         */
        buildConfigField(
            "String",
            "GITHUB_CLIENT_ID",
            "\"" + (project.findProperty("GITHUB_CLIENT_ID") as String? ?: "") + "\"",
        )
        // 仓库地址：应用内更新要查它的 Release
        buildConfigField(
            "String",
            "GITHUB_REPO",
            "\"EliasZWC/Scholarius\"",
        )
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(envKeystoreFile!!)
                storePassword = envKeystorePassword
                keyAlias = envKeyAlias
                keyPassword = envKeyPassword
                // 由 openssl 生成的 PKCS12 密钥库，显式声明避免依 JDK 默认类型
                storeType = "PKCS12"
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // 没配置发布密钥时留空，由下面的任务守卫直接报错。
            // 绝不要回退到 debug 签名：CI 每次生成的 debug 密钥都不同，
            // 会导致新旧版本签名不一致、无法覆盖安装。
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                null
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        // 登录要读 BuildConfig.GITHUB_CLIENT_ID，更新要读 BuildConfig.GITHUB_REPO
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // 冷启动第一帧：把系统默认那张「放大应用图标」的启动页换成纯品牌黑（API 26+ 行为一致）
    implementation("androidx.core:core-splashscreen:1.0.1")
    /*
       登录 token 的加密存储（AES256-GCM，主密钥存在 Android Keystore）。
       access token 等价于账号密码，绝不能明文落盘。
       注意：1.1.0-alpha06 是最后一个不需要 minSdk 23+ 之外额外配置的稳定可用版；
       正式稳定版 1.1.0 已发布，改用稳定版。
     */
    implementation("androidx.security:security-crypto:1.1.0")
}

// 发布包必须用固定密钥签名，否则直接失败。
tasks.matching { it.name.contains("Release") }.configureEach {
    doFirst {
        if (!hasReleaseKeystore) {
            throw GradleException(
                "缺少发布签名：请先设置 KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS / " +
                    "KEY_PASSWORD 环境变量。用随机 debug 密钥签名会导致无法覆盖安装。"
            )
        }
    }
}

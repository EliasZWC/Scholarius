plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// 鐗堟湰鍙凤細鍞竴鏉ユ簮銆傚彧鏈夋槑纭姹傚彂鐗堟椂鎵嶄慨鏀硅繖涓や釜鍊笺€?
// versionCode 姣忔鍙戠増 +1锛泇ersionName 蹇呴』涓?Git 鏍囩 vX.Y.Z 涓殑 X.Y.Z 涓€鑷淬€?
// ---------------------------------------------------------------------------
val appVersionCode = 23
val appVersionName = "0.0.23"

// 鍙€夛細浠庣幆澧冨彉閲忚鍙栧彂甯冪鍚嶏紙鐢?GitHub Actions 娉ㄥ叆锛夈€?
// 鏈厤缃椂鍥為€€鍒?debug 绛惧悕锛屼繚璇佸伐浣滄祦濮嬬粓鑳戒骇鍑哄彲瀹夎鐨?APK銆?
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
           GitHub OAuth App 鐨?client_id锛圖evice Flow 鐢級銆?

           瀹?*涓嶆槸瀵嗛挜**锛屾槑鏂囧啓鍦?APK 閲屾槸 Device Flow 鐨勮璁″厑璁哥殑
           鈥斺€?杩欐鏄€?Device Flow 鑰岄潪甯歌 OAuth 鐨勫師鍥狅細绾鎴风 app
           鏃犳硶瀹夊叏淇濆瓨 client_secret锛屾墍浠ュ共鑴嗕笉鐢?secret銆?

           鍊兼斁鍦?gradle.properties锛圙ITHUB_CLIENT_ID锛夛紝鏀圭殑鏃跺€欎笉鐢ㄥ姩杩欎釜鏂囦欢銆?
           娉ㄥ唽璺緞锛欸itHub 鈫?Settings 鈫?Developer settings 鈫?OAuth Apps
           娉ㄦ剰涓嶈鐢ㄦ梺杈圭殑 GitHub Apps 鈥斺€?閭ｄ釜涓嶆敮鎸?Device Flow銆?
         */
        buildConfigField(
            "String",
            "GITHUB_CLIENT_ID",
            "\"" + (project.findProperty("GITHUB_CLIENT_ID") as String? ?: "") + "\"",
        )
        // 浠撳簱鍦板潃锛氬簲鐢ㄥ唴鏇存柊瑕佹煡瀹冪殑 Release
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
                // 鐢?openssl 鐢熸垚鐨?PKCS12 瀵嗛挜搴擄紝鏄惧紡澹版槑閬垮厤渚?JDK 榛樿绫诲瀷
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
            // 娌￠厤缃彂甯冨瘑閽ユ椂鐣欑┖锛岀敱涓嬮潰鐨勪换鍔″畧鍗洿鎺ユ姤閿欍€?
            // 缁濅笉瑕佸洖閫€鍒?debug 绛惧悕锛欳I 姣忔鐢熸垚鐨?debug 瀵嗛挜閮戒笉鍚岋紝
            // 浼氬鑷存柊鏃х増鏈鍚嶄笉涓€鑷淬€佹棤娉曡鐩栧畨瑁呫€?
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
        // 鐧诲綍瑕佽 BuildConfig.GITHUB_CLIENT_ID锛屾洿鏂拌璇?BuildConfig.GITHUB_REPO
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
    // 鍐峰惎鍔ㄧ涓€甯э細鎶婄郴缁熼粯璁ら偅寮犮€屾斁澶у簲鐢ㄥ浘鏍囥€嶇殑鍚姩椤垫崲鎴愮函鍝佺墝榛戯紙API 26+ 琛屼负涓€鑷达級
    implementation("androidx.core:core-splashscreen:1.0.1")
    /*
       鐧诲綍 token 鐨勫姞瀵嗗瓨鍌紙AES256-GCM锛屼富瀵嗛挜瀛樺湪 Android Keystore锛夈€?
       access token 绛変环浜庤处鍙峰瘑鐮侊紝缁濅笉鑳芥槑鏂囪惤鐩樸€?
       娉ㄦ剰锛?.1.0-alpha06 鏄渶鍚庝竴涓笉闇€瑕?minSdk 23+ 涔嬪棰濆閰嶇疆鐨勭ǔ瀹氬彲鐢ㄧ増锛?
       姝ｅ紡绋冲畾鐗?1.1.0 宸插彂甯冿紝鏀圭敤绋冲畾鐗堛€?
     */
    implementation("androidx.security:security-crypto:1.1.0")
}

// 鍙戝竷鍖呭繀椤荤敤鍥哄畾瀵嗛挜绛惧悕锛屽惁鍒欑洿鎺ュけ璐ャ€?
tasks.matching { it.name.contains("Release") }.configureEach {
    doFirst {
        if (!hasReleaseKeystore) {
            throw GradleException(
                "缂哄皯鍙戝竷绛惧悕锛氳鍏堣缃?KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS / " +
                    "KEY_PASSWORD 鐜鍙橀噺銆傜敤闅忔満 debug 瀵嗛挜绛惧悕浼氬鑷存棤娉曡鐩栧畨瑁呫€?
            )
        }
    }
}

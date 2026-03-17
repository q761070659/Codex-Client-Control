@rem
@rem Gradle startup script for Windows
@rem

@if "%DEBUG%"=="" @echo off
setlocal

set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.

@rem Find Java executable
set JAVA_EXE=java
if defined JAVA_HOME goto findJavaFromJavaHome

:findJavaFromJavaHome
set JAVA_EXE=%JAVA_HOME%/bin/java

:executeGradle
@rem Use Gradle 8.12 from local cache (compatible with Fabric Loom 1.9-SNAPSHOT)
set GRADLE_EXE=%USERPROFILE%\.gradle\wrapper\dists\gradle-8.12-bin\cetblhg4pflnnks72fxwobvgv\gradle-8.12\bin\gradle.bat

if exist "%GRADLE_EXE%" (
    "%GRADLE_EXE%" %*
) else (
    echo Error: Cannot find Gradle executable
    echo Please ensure Gradle is installed or available in the default Gradle wrapper cache
    exit /b 1
)

endlocal

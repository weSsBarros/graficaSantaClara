@echo off
rem Inicia o sistema da Grafica Santa Clara num computador Windows.
rem Precisa do Node.js 22 ou mais novo (https://nodejs.org, versao LTS).
cd /d "%~dp0\.."
if not exist node_modules (
  echo Instalando dependencias pela primeira vez...
  call npm install --omit=dev
)
node server\index.js
pause

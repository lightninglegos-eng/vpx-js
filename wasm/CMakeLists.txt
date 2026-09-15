cmake_minimum_required(VERSION 3.28...3.30)
project(vpx-js-wasm VERSION 3.7.0 LANGUAGES C CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
# Ninja + CMake >=3.28 auto-enables C++20 module-dependency scanning (the -format=p1689
# emscan-deps calls seen in build failures), which requires a working clang-scan-deps binary.
# Neither kernels nor PinMAME/asmjit use real C++20 modules - this scanning is pure overhead
# that fails outright on this toolchain (emscan-deps can't find its underlying scanner), turning
# every single translation unit into a build failure. Disabling it is safe and unrelated to
# actual compilation correctness.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Emscripten required — use: emcmake cmake --preset wasm (or npm run build:wasm)")
endif()

option(PINMAME_WASM_PTHREADS "Enable pthreads (needs COOP/COEP)" ON)

add_subdirectory(modules/kernels)
add_subdirectory(modules/pinmame)

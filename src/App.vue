<template>
  <div class="container">
    <el-text>
      文件上传
    </el-text>
    <el-upload
      class="upload-demo"
      action="/upload"
      :on-change="handleFileChange"
      :show-file-list="true"
    >
      <el-button type="primary">点击上传</el-button>
    </el-upload>
    <el-button type="success" @click.stop="handleResume" v-if="status === Status.pause">恢复</el-button>
    <el-button type="warning" v-else @click.stop="handlePause" :disabled="status !== Status.uploading || !container.hash">
      暂停</el-button>
    <br />
    <span>计算文件Hash进度:</span>
    <el-progress :percentage="hashPercentage" :color="hashPercentageColor"></el-progress>
    <br />
    <span>上传进度:</span>
    <el-progress :percentage="fakeUploadPercentage"></el-progress>
  </div>
</template>

<script  setup>
import { ref, reactive, computed, watch, nextTick } from 'vue'
const Status = {
  wait: 'wait',
  pause: 'pause',
  uploading: 'uploading',
}
// 切片大小 200kb
const SIZE = 200 * 1024

// 基于xhr封装的，用来发送请求的
function request({
  url,
  method = 'post',
  data,
  headers = {},
  onProgress = (e) => e,
  requestList,
}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    // 一个无符号长整型（unsigned long）数字，表示该请求的最大请求时间（毫秒），若超出该时间，请求会自动终止。
    // xhr.timeout = 100000
    xhr.upload.onprogress = onProgress
    xhr.open(method, url)
    Object.keys(headers).forEach((key) =>
      xhr.setRequestHeader(key, headers[key])
    )
    xhr.ontimeout = (e) => {
      console.log('请求超时')
    }
    xhr.send(data)
    // XMLHttpRequest请求成功完成时触发；
    xhr.onload = (e) => {
      // 将请求成功的 xhr 从列表中删除
      if (requestList) {
        const xhrIndex = requestList.findIndex((item) => item === xhr)
        requestList.splice(xhrIndex, 1)
      }
      resolve({
        data: e.target.response,
      })
    }
    // 当请求结束时触发, 无论请求成功(load)还是失败(abort 或 error)。也可以使用 onloadend 属性。
    xhr.onloadend = (e) => e
    // 暴露当前 xhr 给外部
    requestList?.push(xhr)
  })
}

const container = reactive({
  file: null,
  hash: '',
  worker: null,
})
// 当前的请求xhr组成的数组
const requestListArr = ref([])
// 组装的filechunk分段文件
const data = ref([])
const status = ref(Status.wait)
// 生成文件hash的进度
const hashPercentage = ref(0)

const hashPercentageColor = '#f56c6c'
// 文件上传进度
const uploadPercentage = computed(() => {
  if (!container.file || !data.value.length) {
    return 0
  }
  const loaded = data.value
    .map((item) => {
      return item.size * item.percentage
    })
    .reduce((acc, cur) => {
      return acc + cur
    })
  return parseInt((loaded / container.file.size).toFixed(2))
})
// 上传按钮是否可点击
const uploadDisabled = computed(() => {
  return (
    !container.file ||
    [Status.pause, Status.uploading].includes(status.value)
  )
})
// 显示在页面上的文件上传进度
const fakeUploadPercentage = ref(0)
// watch uploadPercentage，得到fakeUploadPercentage
// 至于为什么要这么做，看【恢复上传】的注释
watch(uploadPercentage, (newValue) => {
  if (newValue > fakeUploadPercentage.value) {
    fakeUploadPercentage.value = newValue
  }
})

/**
 * 暂停
 */
function handlePause() {
  status.value = Status.pause
  requestListArr.value.forEach((xhr) => xhr?.abort())
  requestListArr.value = []
  if (container.worker) {
    container.worker.onmessage = null
  }
}
/**
 * 重置
 */
function resetData() {
  hashPercentage.value = 0
  uploadPercentage.value = 0
  fakeUploadPercentage.value = 0
  requestListArr.value.forEach((xhr) => xhr?.abort())
  requestListArr.value = []
  if (container.worker) {
    container.worker.onmessage = null
  }
}

/**
 * 【恢复上传】
 * 上传进度是实时根据所有的上传切片的进度汇总来的
 * 只有某个切片完整/全部上传到了服务端，才算这个切片上传完成了
 * 如果，一些切片如果只上传了一部分，就被暂停了，那么恢复上传时，这一些切片是需要重新上传的
 * 这样就会导致恢复上传时，上传进度倒退的问题（因为上传进度是计算属性，是实时计算切片，汇总而来的）
 */
async function handleResume() {
  status.value = Status.uploading
  const { uploadedList } = await verifyUpload(
    container.file.name,
    container.hash
  )
  uploadChunks(uploadedList)
}

/**
 * 选择了文件
 */
function handleFileChange(file, fileList) {
      const selectedFile = fileList[0];
      if (!selectedFile) return;
      resetData(); // 重置数据
      container.file = selectedFile.raw; // 将选择的文件存储在容器对象中
      console.log(container.file.name); // 打印选择的文件名
      handleUpload()
}

// 上传按钮
async function handleUpload() {
  if (!container.file) {
    return
  }
  // 点了上传按钮，状态改为上传中...
  status.value = Status.uploading
  // 文件分片
  const fileChunkList = createFileChunk(container.file)
  console.log('文件分了多少片：', fileChunkList.length)
  // 文件hash
  container.hash = await calculateHash(fileChunkList)
  console.log('文件hash是：', container.hash)

  // uploadedList已上传的切片的切片文件名称
  const { shouldUpload, uploadedList } = await verifyUpload(
    container.file.name,
    container.hash
  )

  // 组装的filechunk数据先置空
  data.value = []

  // 服务器已经有完整文件了
  if (!shouldUpload) {
    fakeUploadPercentage.value = 100
    status.value = Status.wait
    await nextTick()
    alert('秒传：上传成功')
    return
  }

  data.value = fileChunkList.map(({ file }, index) => ({
    fileHash: container.hash,
    index,
    hash: `${container.hash}-${index}`,
    chunk: file,
    size: file.size,
    // 如果已上传切片数组uploadedList中包含这个切片，则证明这个切片之前已经上传成功了，进度设为100。
    percentage: uploadedList.includes(index) ? 100 : 0,
  }))
  uploadChunks(uploadedList)
}
function calculateHash(fileChunkList) {
  return new Promise((resolve) => {
    container.worker = new Worker('/hash.js')
    container.worker.postMessage({ fileChunkList })
    container.worker.onmessage = (e) => {
      const { percentage, hash } = e.data
      hashPercentage.value = percentage.toFixed(2)
      if (hash) {
        resolve(hash)
      }
    }
  })
}

// 生成文件切片
function createFileChunk(file, size = SIZE) {
  const fileChunkList = []
  let cur = 0
  while (cur < file.size) {
    fileChunkList.push({
      file: file.slice(cur, cur + size),
    })
    cur += size
  }
  console.log(fileChunkList);
  return fileChunkList
}

/**
 * 上传切片，同时过滤已上传的切片
 * uploadedList：已经上传了的切片，这次不用上传了
 */
async function uploadChunks(uploadedList = []) {
  console.log(uploadedList, 'uploadedList')
  const requestList = data.value
    .filter(({ hash }) => !uploadedList.includes(hash))
    .map(({ chunk, hash, index }) => {
      const formData = new FormData()
      // 切片文件
      formData.append('chunk', chunk)
      // 切片文件hash
      formData.append('hash', hash)
      // 大文件的文件名
      formData.append('filename', container.file.name)
      // 大文件hash
      formData.append('fileHash', container.hash)
      return { formData, index }
    })
    .map(async ({ formData, index }) =>
      request({
        url: 'http://localhost:9999',
        data: formData,
        onProgress: createProgressHandler(index, data.value[index]),
        requestList: requestListArr.value,
      })
    )

  // 并发切片
  await Promise.all(requestList)

  // 之前上传的切片数量 + 本次上传的切片数量 = 所有切片数量时
  // 切片并发上传完以后，发个请求告诉后端：合并切片
  if (uploadedList.length + requestList.length === data.value.length) {
    mergeRequest()
  }
}

/**
 * 上传切片进度的回调函数
 * 用闭包保存每个chunk的进度数据
 */
function createProgressHandler(index, item) {
  return (e) => {
    if (e.lengthComputable) {
      item.percentage = parseInt(String((e.loaded / e.total) * 100))
    }
  }
}

/**
 * 验证该文件是否需要上次，文件通过hash生成唯一，改名后也是不需要再上传的，也就相当于妙传
 */
async function verifyUpload(filename, fileHash) {
  const { data } = await request({
    url: 'http://localhost:9999/verify',
    headers: {
      'content-type': 'application/json',
    },
    data: JSON.stringify({
      filename,
      fileHash,
    }),
  })
  return JSON.parse(data)
}

/**
 * 发请求通知服务器，合并切片啦～
 */
async function mergeRequest() {
  await request({
    url: 'http://localhost:9999/merge',
    headers: {
      'content-type': 'application/json',
    },
    data: JSON.stringify({
      size: SIZE,
      fileHash: container.hash,
      filename: container.file.name,
    }),
  })
  alert('上传成功')
  status.value = Status.wait
}

</script>

<style scoped>
.container {
  height: 8rem;
  width: 100%;
  margin: 0 auto;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}

.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}

.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>

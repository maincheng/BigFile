

# 大文件分片上传

### 前言：

**本项目包含前端（**`vue3`）和后端（`nodejs`），展示了大文件上传在实际项目中的使用方法。

## 直接上传的问题

**正常的向后端发送请求，常见的 **`get`、`post` 大家都很熟悉，是没有任何问题的；我们也可以用 `post` 或者表单请求发送 file文件到后端。 但是大文件的上传是一个特殊的情况： 大文件上传最主要的问题就在于：在一个请求中，要上传大量的数据，导致整个过程会比较漫长，且失败后需要重头开始上传。

* **上传时间较久，在这个过程中不能做其他操作，用户不能刷新页面，只能耐心等待请求完成。**
* **无法得知上传进度，无法暂停。**
* **常见的软件应用中，前端/后端都会对一个请求的时间进行限制，那么大文件的上传就会很容易超时，导致上传失败。**
* **上传失败就要从头开始，难以接受。**

## 前端：

**使用了vue+vite+element**

### 模版部分：

```
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
```

**原生是** `input`标签，`type=‘file’`即可，这里使用了 `el-upload`。绑定一个 `change`事件。

```
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
```

**这一步先拿到文件，然后直接调用上传函数handleUpload()。**

**进入上传之前，首先要对文件进行分片。**

### 分片

**可以自行设置一个切片大小，我这里设置为200kb。**

```
// 切片大小 200kb
const SIZE = 200 * 1024
```

**接下来是分片的重点部分了：**

```
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
```

**在 **`JavaScript` 中，文件 `File` 对象是 `Blob` 对象的子类，`Blob` 对象包含一个重要的方法 `slice`，通过这个方法，我们就可以对二进制文件进行拆分。文件切分之后的切片其实还是一个 `Blob`对象。切完之后得到一个 `file`的数组 `fileChunkList`，然后每次请求只需要上传这一个部分的分块即可。服务器接收到这些切片后，再将他们拼接起来就可以了。

### 得到源文件的Hash值

**拿到原文件的 **`hash` 值是关键的一步，同一个文件就算改文件名，`hash` 值也不会变，就可以避免文件改名后重复上传的问题。

```
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
```

**这里我们使用**[spark-md5.min.js](https://github.com/Neveryu/bigfile-upload/blob/master/public/spark-md5.min.js) 来根据文件的二进制内容计算文件的 `hash`。考虑到如果上传一个超大文件，读取文件内容计算 `hash` 是非常耗费时间的，并且会引起 UI 的阻塞，导致页面假死状态，所以我们使用 `web-worker` 在 `worker` 线程计算 `hash`，这样用户仍可以在主界面正常的交互。

**注意：由于实例化 **`web-worker` 时，参数是一个 `js` 文件路径且不能跨域，所以我们单独创建一个 `hash.js` 文件放在 `public` 目录下，另外在 `worker` 中也是不允许访问 `dom` 的，但它提供了 `importScripts` 函数用于导入外部脚本，通过它导入 `spark-md5`。

```
// public/hash.js
self.onmessage = e => {
const { fileChunkList } = e.data
const spark = new self.SparkMD5.ArrayBuffer()
let percentage = 0
let count = 0
const loadNext = index => {
const reader = new FileReader()
reader.readAsArrayBuffer(fileChunkList[index].file)
reader.onload = e => {
count++
spark.append(e.target.result)
if (count === fileChunkList.length) {
self.postMessage({
percentage: 100,
hash: spark.end()
})
self.close()
} else {
percentage += 100 / fileChunkList.length
self.postMessage({
percentage
})
loadNext(count)
}
}
}
loadNext(count)
}
```

**使用** `onmessage`接受数据，使用 `postmessage`传递数据。

### 文件上传

**首先验证文件是否已经在服务器上了，如果存在就不用再上传，骗一手秒传。**

```
const { shouldUpload, uploadedList } = await verifyUpload(
    container.file.name,
    container.hash
  )
```

**然后上传除了** `uploadedList`之外的文件切片。

```
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
```

**使用** `filter`过滤出服务器上没有的文件切片，再使用一个 `map`将每个切片的数据添加到 `formData`中，再使用一个 `map`对每一个切片进行上传。

## 后端

### 文件合并

**前端发送切片完成后，发送一个合并请求，后端收到请求后，将之前上传的切片文件合并。**

**使用** `nodejs`实现为例：

```
/**
 * 合并文件夹中的切片，生成一个完整的文件
 */
const mergeFileChunk = async (filePath, fileHash, size) => {
// 所有的文件切片放在以“大文件-文件hash命名文件夹”中
const chunkDir = path.resolve(UPLOAD_DIR, fileHash)
const chunkPaths = await fse.readdir(chunkDir)
// 根据切片下标进行排序
// 否则直接读取目录的获得的顺序可能会错乱
chunkPaths.sort((a, b) => {
return a.split('-')[1] - b.split('-')[1]
})
await Promise.all(
chunkPaths.map((chunkPath, index) => {
return pipeStream(
path.resolve(chunkDir, chunkPath),
/**
 * 创建写入的目标文件的流，并指定位置，
 * 目的是能够并发合并多个可读流到可写流中，这样即使流的顺序不同也能传输到正确的位置，
 * 所以这里还需要让前端在请求的时候多提供一个 size 参数。
 * 其实也可以等上一个切片合并完后再合并下个切片，这样就不需要指定位置，
 * 但传输速度会降低，所以使用了并发合并的手段，
 */
fse.createWriteStream(filePath, {
start: index * size,
end: (index + 1) * size
})
)
})
)

// 文件合并后删除保存切片的目录
fse.rmdirSync(chunkDir)
}
```

## 显示进度

**我们可以通过 **`onprogress` 事件来实时显示进度，默认情况下这个事件每 50ms 触发一次。需要注意的是，上传过程和下载过程触发的是不同对象的 `onprogress` 事件：上传触发的是 `xhr.upload` 对象的 `onprogress` 事件，下载触发的是 `xhr` 对象的 `onprogress` 事件。

```
xhr.onprogress = updateProgress;
xhr.upload.onprogress = updateProgress;

function updateProgress(event) {
  if (event.lengthComputable) {
    var completedPercent = event.loaded / event.total;
  }
}
```

## 暂停上传

**一个请求能被取消的前提是，我们需要将未收到响应的请求保存在一个列表中，然后依次调用每个 **`xhr` 对象的 `abort` 方法。调用这个方法后，`xhr` 对象会停止触发事件，将请求的 `status` 置为 `0`，并且无法访问任何与响应有关的属性。

```
/**
 * 暂停
 */
function handlePause() {
  requestListArr.value.forEach((xhr) => xhr?.abort())
  requestListArr.value = []
}
```



项目地址：[maincheng/BigFile (github.com)](https://github.com/maincheng/BigFile)

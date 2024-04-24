/**
 * 在 worker 中也是不允许访问 dom 的；
 * 但它提供了importScripts函数用于导入外部脚本，通过它导入spark-md5；
 * Worker中没有window，Worker中self指向顶层对象。
 */
self.importScripts('./spark-md5.min.js')

/**
 * 正因为每个文件的md5是一样的，那么，我们在做文件上传的时候，
 * 就只要在前端先获取要上传的文件md5值，
 * 并把文件md5传到服务器进行校验，对比之前文件的md5，如果存在相同的md5，
 * 我们只要把文件的名字传到服务器关联之前的文件即可，并不需要再次去上传相同的文件。
 */
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


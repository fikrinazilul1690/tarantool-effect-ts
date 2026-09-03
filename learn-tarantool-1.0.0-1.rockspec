package = "learn-tarantool"
version = "1.0.0-1"

source = {
	url = ".",
}

description = {
	summary = "Tarantool vshard application dependencies",
	license = "MIT",
}

dependencies = {
	"checks == 3.4.1",
	"errors == 2.2.1",
	"vshard == 0.1.42",
	"crud == 1.7.5",
}

build = {
	type = "none",
}

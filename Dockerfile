# $ docker build -t mantis2gitlab .
# $ docker run -it --rm --name mynpm mantis2gitlab m2gl
# $ docker run -it --rm --name my-running-script -v "$PWD":/usr/src/app -w /usr/src/app node:8 node your-daemon-or-script.js

# specify the node base image with your desired version node:<version>
FROM node:alpine
WORKDIR /usr/app
COPY ./ /usr/app

RUN npm install

CMD [ "npm", "start" ]

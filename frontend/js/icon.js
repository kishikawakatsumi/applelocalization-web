"use strict";

import { library, dom } from "@fortawesome/fontawesome-svg-core";
import {
  faSearch, faToolbox, faAngleDown, faHeart, faAt,
  faMobile, faDesktop,
} from "@fortawesome/free-solid-svg-icons";
import { faCommentDots } from "@fortawesome/free-regular-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

library.add(faSearch, faToolbox, faAngleDown, faHeart, faAt,
  faMobile, faDesktop, faCommentDots, faGithub);
dom.watch();
